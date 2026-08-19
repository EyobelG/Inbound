-- ============================================================================
-- Inbound :: 0001_schema.sql
-- Core spatial schema for transit-aware date itineraries (Boston / Cambridge /
-- Somerville).
--
-- Target: the Cloud SQL for PostgreSQL instance backing Firebase Data Connect.
-- Apply with psql against that instance directly - Data Connect's GraphQL
-- schema language cannot express PostGIS types, triggers, or RLS policies, so
-- the spatial core has to live here rather than in a .gql file.
-- ============================================================================

create extension if not exists postgis;
create extension if not exists pg_trgm;      -- station + spot autocomplete
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- app_users
--
-- Firebase Auth owns identity; this table is the local projection of it so
-- foreign keys have something to point at. `firebase_uid` is Firebase's own
-- string uid (28 chars, not a UUID), and it is the primary key precisely so
-- that a row cannot exist for a user Firebase has never seen. Rows are
-- upserted on first authenticated request - see `ensureAppUser` in
-- src/lib/auth.ts.
-- ---------------------------------------------------------------------------
create table app_users (
  firebase_uid text primary key check (char_length(firebase_uid) between 1 and 128),
  email        text,
  display_name text,
  photo_url    text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type mbta_line as enum (
  'red', 'green_b', 'green_c', 'green_d', 'green_e', 'orange', 'blue'
);

create type spot_category as enum (
  'bar', 'cafe', 'activity', 'dessert', 'restaurant', 'walk_park'
);

create type price_tier as enum ('$', '$$', '$$$', '$$$$');

create type date_stage as enum (
  'first_date', 'second_or_third', 'established_exclusive', 'anniversary'
);

create type season as enum ('all_year', 'summer_fall', 'winter_cozy');

create type photo_source as enum ('google_places', 'community_upload');

-- ---------------------------------------------------------------------------
-- mbta_stations
--
-- `order_index` gives adjacency along a line, but the Red Line (Ashmont /
-- Braintree) and Green Line (GLX) physically branch, so order_index alone
-- produces phantom adjacencies between branch tips. `branch` disambiguates:
-- two stations are adjacent iff same line AND (same branch OR either is on the
-- shared trunk, i.e. branch IS NULL) AND |order_index delta| = 1.
-- ---------------------------------------------------------------------------
create table mbta_stations (
  id              uuid primary key default uuid_generate_v4(),
  gtfs_stop_id    text unique not null,          -- e.g. 'place-davis'
  stop_name       text not null,
  line            mbta_line not null,
  branch          text,                          -- 'ashmont' | 'braintree' | NULL (trunk)
  location        geography(point, 4326) not null,
  order_index     integer not null,
  is_accessible   boolean not null default true,
  created_at      timestamptz not null default now(),

  -- One physical platform per line appears once; transfer stations (Park St.)
  -- legitimately appear once per line that serves them.
  unique (gtfs_stop_id, line),
  unique (line, branch, order_index)
);

create index mbta_stations_location_gix on mbta_stations using gist (location);
create index mbta_stations_line_idx     on mbta_stations (line, order_index);
create index mbta_stations_name_trgm    on mbta_stations using gin (stop_name gin_trgm_ops);

-- Transfer edges between co-located platforms of different lines
-- (Park St red<->green, State orange<->blue, ...). Directionless; stored once
-- with a canonical ordering enforced by the check.
create table mbta_transfers (
  station_a_id      uuid not null references mbta_stations(id) on delete cascade,
  station_b_id      uuid not null references mbta_stations(id) on delete cascade,
  transfer_minutes  numeric(4,1) not null default 3.0 check (transfer_minutes >= 0),
  primary key (station_a_id, station_b_id),
  check (station_a_id < station_b_id)
);

-- ---------------------------------------------------------------------------
-- spots
-- ---------------------------------------------------------------------------
create table spots (
  id                     uuid primary key default uuid_generate_v4(),
  name                   text not null,
  slug                   text unique not null,
  neighborhood           text not null,              -- 'Back Bay', 'Central Sq', 'South End'
  address                text not null,
  location               geography(point, 4326) not null,
  price_tier             price_tier not null,
  category               spot_category not null,
  nearest_station_id     uuid references mbta_stations(id) on delete set null,
  walking_minutes_to_t   integer check (walking_minutes_to_t between 0 and 60),
  google_place_id        text unique,
  -- Baseline hours from Google Places, normalized to
  -- [{ day: 0-6, open: 'HH:MM', close: 'HH:MM' }]. close < open means the
  -- venue runs past midnight; the itinerary matcher handles the wrap.
  opening_hours          jsonb not null default '[]'::jsonb,
  is_verified            boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index spots_location_gix     on spots using gist (location);
create index spots_category_idx     on spots (category);
create index spots_station_idx      on spots (nearest_station_id);
create index spots_neighborhood_idx on spots (neighborhood);
create index spots_name_trgm        on spots using gin (name gin_trgm_ops);
-- Partial index: the search endpoint only ever serves verified spots.
create index spots_verified_idx     on spots (is_verified) where is_verified;

-- ---------------------------------------------------------------------------
-- spot_vibes :: denormalized aggregate, maintained exclusively by trigger.
-- Never written directly by application code.
-- ---------------------------------------------------------------------------
create table spot_vibes (
  spot_id             uuid primary key references spots(id) on delete cascade,
  avg_noise_level     numeric(3,2) check (avg_noise_level between 1.0 and 5.0),
  lighting_score      numeric(3,2) check (lighting_score between 1.0 and 5.0),
  easy_exit_score     numeric(3,2) check (easy_exit_score between 1.0 and 5.0),
  -- Vote tallies, not booleans: {"first_date": 12, "second_or_third": 4, ...}
  best_for_stage      jsonb not null default
    '{"first_date":0,"second_or_third":0,"established_exclusive":0,"anniversary":0}'::jsonb,
  total_reviews_count integer not null default 0 check (total_reviews_count >= 0),
  updated_at          timestamptz not null default now()
);

-- Vibe filters are the hottest predicate in /api/spots/search.
create index spot_vibes_noise_idx    on spot_vibes (avg_noise_level);
create index spot_vibes_lighting_idx on spot_vibes (lighting_score);
create index spot_vibes_stage_gin    on spot_vibes using gin (best_for_stage jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- itineraries
-- ---------------------------------------------------------------------------
create table itineraries (
  id                     uuid primary key default uuid_generate_v4(),
  creator_id             text not null references app_users(firebase_uid) on delete cascade,
  title                  text not null check (char_length(title) between 3 and 120),
  description            text,
  total_duration_minutes integer check (total_duration_minutes between 15 and 600),
  budget_estimate        integer check (budget_estimate >= 0),   -- USD per person
  season                 season not null default 'all_year',
  is_public              boolean not null default true,
  upvotes_count          integer not null default 0 check (upvotes_count >= 0),
  created_at             timestamptz not null default now()
);

create index itineraries_creator_idx on itineraries (creator_id);
create index itineraries_ranked_idx  on itineraries (upvotes_count desc, created_at desc)
  where is_public;

create table itinerary_stops (
  id            uuid primary key default uuid_generate_v4(),
  itinerary_id  uuid not null references itineraries(id) on delete cascade,
  spot_id       uuid not null references spots(id) on delete restrict,
  step_order    integer not null check (step_order between 1 and 5),
  transit_note  text,                       -- "3 min walk across Elm St"
  custom_tip    text,
  unique (itinerary_id, step_order),
  unique (itinerary_id, spot_id)            -- no doubling back to the same bar
);

create index itinerary_stops_itinerary_idx on itinerary_stops (itinerary_id, step_order);
create index itinerary_stops_spot_idx      on itinerary_stops (spot_id);

create table itinerary_upvotes (
  itinerary_id uuid not null references itineraries(id) on delete cascade,
  user_id      text not null references app_users(firebase_uid) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (itinerary_id, user_id)
);

-- ---------------------------------------------------------------------------
-- user_reviews :: source of truth for everything in spot_vibes.
-- One review per user per spot; resubmission is an UPDATE (the API upserts).
-- ---------------------------------------------------------------------------
create table user_reviews (
  id                uuid primary key default uuid_generate_v4(),
  spot_id           uuid not null references spots(id) on delete cascade,
  user_id           text not null references app_users(firebase_uid) on delete cascade,
  noise_rating      smallint not null check (noise_rating between 1 and 5),
  lighting_rating   smallint not null check (lighting_rating between 1 and 5),
  easy_exit_rating  smallint not null check (easy_exit_rating between 1 and 5),
  date_stage        date_stage not null,
  body_text         text check (char_length(body_text) <= 2000),
  helpful_count     integer not null default 0 check (helpful_count >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (spot_id, user_id)
);

create index user_reviews_spot_idx    on user_reviews (spot_id);
create index user_reviews_user_idx    on user_reviews (user_id);
-- Backs the "most upvoted quote" snippet on DateSpotCard.
create index user_reviews_helpful_idx on user_reviews (spot_id, helpful_count desc)
  where body_text is not null;

-- ---------------------------------------------------------------------------
-- spot_photos
-- ---------------------------------------------------------------------------
create table spot_photos (
  id                  uuid primary key default uuid_generate_v4(),
  spot_id             uuid not null references spots(id) on delete cascade,
  url                 text not null,
  caption             text,
  source              photo_source not null,
  uploaded_by_user_id text references app_users(firebase_uid) on delete set null,
  display_order       integer not null default 0,
  created_at          timestamptz not null default now(),
  -- Google photos are attributed to the API, not a person; community uploads
  -- must name an uploader so moderation and takedown have a subject.
  check (
    (source = 'community_upload' and uploaded_by_user_id is not null)
    or source = 'google_places'
  )
);

create index spot_photos_spot_idx on spot_photos (spot_id, display_order);
