-- ============================================================================
-- Inbound :: 0003_rls.sql
-- Row Level Security, keyed on the Firebase uid carried by the connection.
--
-- Supabase supplied `auth.uid()` from the request JWT automatically. On plain
-- Cloud SQL nothing does that for us, so the application is responsible for
-- setting `app.firebase_uid` per transaction after verifying the Firebase ID
-- token. `withUser()` in src/lib/db/pool.ts is the only place that may do it.
--
-- IMPORTANT: RLS does not apply to the table owner or to superusers. The
-- migration role must therefore differ from the runtime role, and the runtime
-- role must NOT own these tables. See the grants at the bottom.
-- ============================================================================

alter table app_users        enable row level security;
alter table mbta_stations    enable row level security;
alter table mbta_transfers   enable row level security;
alter table spots            enable row level security;
alter table spot_vibes       enable row level security;
alter table spot_photos      enable row level security;
alter table itineraries      enable row level security;
alter table itinerary_stops  enable row level security;
alter table itinerary_upvotes enable row level security;
alter table user_reviews     enable row level security;

-- --- Reference data: readable by everyone, written only by the migration /
-- --- seeding role, which bypasses RLS by owning the tables. -----------------
create policy stations_public_read  on mbta_stations  for select using (true);
create policy transfers_public_read on mbta_transfers for select using (true);
create policy spots_public_read     on spots          for select using (true);
create policy vibes_public_read     on spot_vibes     for select using (true);
create policy photos_public_read    on spot_photos    for select using (true);

-- spot_vibes is trigger-maintained; deliberately no write policy exists, so
-- every direct INSERT/UPDATE from the runtime role is denied by default.

-- --- Identity: a user may read and update only their own projection --------
create policy app_users_read_self on app_users for select
  using (firebase_uid = current_firebase_uid());

create policy app_users_upsert_self on app_users for insert
  with check (firebase_uid = current_firebase_uid());

create policy app_users_update_self on app_users for update
  using (firebase_uid = current_firebase_uid())
  with check (firebase_uid = current_firebase_uid());

-- --- Photos: users may add and remove their own community uploads ----------
create policy photos_insert_own on spot_photos for insert
  with check (
    source = 'community_upload'
    and uploaded_by_user_id = current_firebase_uid()
  );

create policy photos_delete_own on spot_photos for delete
  using (uploaded_by_user_id = current_firebase_uid());

-- --- Reviews: public to read, one row per author to write ------------------
create policy reviews_public_read on user_reviews for select using (true);

create policy reviews_insert_own on user_reviews for insert
  with check (user_id = current_firebase_uid());

create policy reviews_update_own on user_reviews for update
  using (user_id = current_firebase_uid())
  with check (user_id = current_firebase_uid());

create policy reviews_delete_own on user_reviews for delete
  using (user_id = current_firebase_uid());

-- --- Itineraries: public ones readable by all, private ones by the author --
create policy itineraries_read on itineraries for select
  using (is_public or creator_id = current_firebase_uid());

create policy itineraries_insert_own on itineraries for insert
  with check (creator_id = current_firebase_uid());

create policy itineraries_update_own on itineraries for update
  using (creator_id = current_firebase_uid())
  with check (creator_id = current_firebase_uid());

create policy itineraries_delete_own on itineraries for delete
  using (creator_id = current_firebase_uid());

-- --- Stops inherit the visibility and ownership of their parent itinerary --
create policy stops_read on itinerary_stops for select
  using (exists (
    select 1 from itineraries i
     where i.id = itinerary_id
       and (i.is_public or i.creator_id = current_firebase_uid())
  ));

create policy stops_write_own on itinerary_stops for all
  using (exists (
    select 1 from itineraries i
     where i.id = itinerary_id and i.creator_id = current_firebase_uid()
  ))
  with check (exists (
    select 1 from itineraries i
     where i.id = itinerary_id and i.creator_id = current_firebase_uid()
  ));

-- --- Upvotes: readable by all, one row per user ----------------------------
create policy upvotes_read on itinerary_upvotes for select using (true);

create policy upvotes_write_own on itinerary_upvotes for all
  using (user_id = current_firebase_uid())
  with check (user_id = current_firebase_uid());

-- ---------------------------------------------------------------------------
-- Runtime role
--
-- Create this role once, and connect the app as it. It deliberately has no
-- table ownership and no BYPASSRLS, so the policies above actually bind - a
-- runtime connection using the owner role would silently ignore every one of
-- them.
--
--   create role inbound_app login password '...';
--
-- The grants are skipped with a notice when that role does not exist yet, so a
-- first `npm run db:migrate` against a fresh database succeeds rather than
-- aborting under ON_ERROR_STOP. Re-run the migration after creating the role.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'inbound_app') then
    raise notice 'Role inbound_app does not exist - skipping grants. Create it, then re-run this file.';
    return;
  end if;

  grant usage on schema public to inbound_app;
  grant select, insert, update, delete on all tables in schema public to inbound_app;
  grant usage, select on all sequences in schema public to inbound_app;
  grant execute on all functions in schema public to inbound_app;
end
$$;
