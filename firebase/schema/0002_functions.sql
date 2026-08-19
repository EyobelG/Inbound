-- ============================================================================
-- Inbound :: 0002_functions.sql
-- Spatial helpers, aggregate triggers, and the search RPC.
--
-- Unchanged by the move off Supabase: none of this depended on Supabase, only
-- on PostgreSQL + PostGIS. The one addition is `current_firebase_uid()`, which
-- gives the RLS policies in 0003 a caller identity now that `auth.uid()` is
-- gone.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- current_firebase_uid
--
-- Reads the uid the connection set with `SET LOCAL app.firebase_uid`, which
-- `withUser()` in src/lib/db/pool.ts does inside every request transaction.
-- The `true` second argument makes a missing setting return NULL instead of
-- raising, so unauthenticated reads work and simply match no ownership policy.
-- ---------------------------------------------------------------------------
create or replace function current_firebase_uid() returns text
language sql stable
as $$
  select nullif(current_setting('app.firebase_uid', true), '')
$$;

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger spots_touch_updated_at
  before update on spots
  for each row execute function touch_updated_at();

create trigger user_reviews_touch_updated_at
  before update on user_reviews
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- spots_near_station
--
-- Every spot within `radius_meters` of a station, ordered by true geodesic
-- distance. Uses ST_DWithin on geography so the GIST index is used and the
-- radius is real metres, not degrees.
--
-- Walking minutes are derived, not stored: straight-line distance is scaled by
-- 1.35 (Boston street-grid detour factor) and divided by an 80 m/min walk.
-- ---------------------------------------------------------------------------
create or replace function spots_near_station(
  p_station_id    uuid,
  p_radius_meters integer default 400,
  p_categories    spot_category[] default null,
  p_max_noise     numeric default null,
  p_min_lighting  numeric default null,
  p_price_tiers   price_tier[] default null,
  p_date_stage    text default null,
  p_limit         integer default 50
)
returns table (
  spot_id          uuid,
  name             text,
  slug             text,
  neighborhood     text,
  category         spot_category,
  price_tier       price_tier,
  distance_meters  numeric,
  walking_minutes  integer,
  avg_noise_level  numeric,
  lighting_score   numeric,
  easy_exit_score  numeric,
  stage_votes      integer,
  total_reviews    integer
)
language sql stable
security invoker
set search_path = public
as $$
  with station as (
    select location from mbta_stations where id = p_station_id
  )
  select
    s.id,
    s.name,
    s.slug,
    s.neighborhood,
    s.category,
    s.price_tier,
    round(st_distance(s.location, st.location)::numeric, 1) as distance_meters,
    greatest(
      1,
      ceil(st_distance(s.location, st.location) * 1.35 / 80.0)::integer
    ) as walking_minutes,
    v.avg_noise_level,
    v.lighting_score,
    v.easy_exit_score,
    coalesce((v.best_for_stage ->> p_date_stage)::integer, 0) as stage_votes,
    coalesce(v.total_reviews_count, 0) as total_reviews
  from spots s
  cross join station st
  left join spot_vibes v on v.spot_id = s.id
  where s.is_verified
    and st_dwithin(s.location, st.location, p_radius_meters)
    and (p_categories  is null or s.category   = any(p_categories))
    and (p_price_tiers is null or s.price_tier = any(p_price_tiers))
    -- Unreviewed spots pass vibe filters rather than being hidden forever;
    -- cold-start inventory would otherwise be unreachable.
    and (p_max_noise    is null or v.avg_noise_level is null or v.avg_noise_level <= p_max_noise)
    and (p_min_lighting is null or v.lighting_score  is null or v.lighting_score  >= p_min_lighting)
  order by
    case when p_date_stage is null then 0
         else coalesce((v.best_for_stage ->> p_date_stage)::integer, 0) end desc,
    st_distance(s.location, st.location) asc
  limit least(p_limit, 200);
$$;

-- ---------------------------------------------------------------------------
-- spots_near_point :: same idea, arbitrary origin (used by the two-step
-- matcher when pairing Step 2 against a chosen Step 1).
-- ---------------------------------------------------------------------------
create or replace function spots_near_point(
  p_lng           double precision,
  p_lat           double precision,
  p_radius_meters integer default 600,
  p_categories    spot_category[] default null,
  p_exclude_spot  uuid default null,
  p_limit         integer default 50
)
returns table (
  spot_id         uuid,
  name            text,
  slug            text,
  category        spot_category,
  price_tier      price_tier,
  distance_meters numeric,
  avg_noise_level numeric,
  lighting_score  numeric,
  easy_exit_score numeric,
  best_for_stage  jsonb,
  total_reviews   integer
)
language sql stable
security invoker
set search_path = public
as $$
  with origin as (
    select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography as g
  )
  select
    s.id, s.name, s.slug, s.category, s.price_tier,
    round(st_distance(s.location, o.g)::numeric, 1),
    v.avg_noise_level, v.lighting_score, v.easy_exit_score,
    coalesce(v.best_for_stage, '{}'::jsonb),
    coalesce(v.total_reviews_count, 0)
  from spots s
  cross join origin o
  left join spot_vibes v on v.spot_id = s.id
  where s.is_verified
    and st_dwithin(s.location, o.g, p_radius_meters)
    and (p_categories   is null or s.category = any(p_categories))
    and (p_exclude_spot is null or s.id <> p_exclude_spot)
  order by st_distance(s.location, o.g) asc
  limit least(p_limit, 200);
$$;

-- ---------------------------------------------------------------------------
-- attach_nearest_station :: on insert/move, bind a spot to its closest station
-- and precompute the walk. <-> on geography is a KNN index scan, so this stays
-- cheap even during bulk seeding.
-- ---------------------------------------------------------------------------
create or replace function attach_nearest_station() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_station_id uuid;
  v_distance   double precision;
begin
  select st.id, st_distance(st.location, new.location)
    into v_station_id, v_distance
  from mbta_stations st
  order by st.location <-> new.location
  limit 1;

  new.nearest_station_id   := v_station_id;
  new.walking_minutes_to_t := greatest(1, ceil(v_distance * 1.35 / 80.0)::integer);
  return new;
end;
$$;

create trigger spots_attach_nearest_station
  before insert or update of location on spots
  for each row execute function attach_nearest_station();

-- ---------------------------------------------------------------------------
-- recalc_spot_vibes :: single source of truth for the aggregate row.
--
-- Recomputes from user_reviews rather than applying a running delta: deltas
-- drift on UPDATE and DELETE, and a spot has hundreds of reviews at most, so
-- the full re-aggregate is cheap and always correct.
-- ---------------------------------------------------------------------------
create or replace function recalc_spot_vibes() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spot_id uuid := coalesce(new.spot_id, old.spot_id);
begin
  insert into spot_vibes as sv (
    spot_id, avg_noise_level, lighting_score, easy_exit_score,
    best_for_stage, total_reviews_count, updated_at
  )
  select
    v_spot_id,
    round(avg(r.noise_rating)::numeric, 2),
    round(avg(r.lighting_rating)::numeric, 2),
    round(avg(r.easy_exit_rating)::numeric, 2),
    jsonb_build_object(
      'first_date',            count(*) filter (where r.date_stage = 'first_date'),
      'second_or_third',       count(*) filter (where r.date_stage = 'second_or_third'),
      'established_exclusive', count(*) filter (where r.date_stage = 'established_exclusive'),
      'anniversary',           count(*) filter (where r.date_stage = 'anniversary')
    ),
    count(*),
    now()
  from user_reviews r
  where r.spot_id = v_spot_id
  on conflict (spot_id) do update set
    avg_noise_level     = excluded.avg_noise_level,
    lighting_score      = excluded.lighting_score,
    easy_exit_score     = excluded.easy_exit_score,
    best_for_stage      = excluded.best_for_stage,
    total_reviews_count = excluded.total_reviews_count,
    updated_at          = excluded.updated_at;

  return null;
end;
$$;

create trigger user_reviews_recalc_vibes
  after insert or update or delete on user_reviews
  for each row execute function recalc_spot_vibes();

-- ---------------------------------------------------------------------------
-- Denormalized upvote counter
-- ---------------------------------------------------------------------------
create or replace function sync_itinerary_upvotes() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update itineraries i
     set upvotes_count = (
       select count(*) from itinerary_upvotes u
        where u.itinerary_id = coalesce(new.itinerary_id, old.itinerary_id)
     )
   where i.id = coalesce(new.itinerary_id, old.itinerary_id);
  return null;
end;
$$;

create trigger itinerary_upvotes_sync
  after insert or delete on itinerary_upvotes
  for each row execute function sync_itinerary_upvotes();
