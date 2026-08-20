-- ============================================================================
-- Inbound :: 0005_photo_attempts.sql
-- Bookkeeping so the Commons photo seeder's queue advances.
--
-- The seeder selects spots with no photo, ordered by created_at, limited to a
-- batch. A miss recorded nothing, so the next run re-selected the identical
-- batch - the daily cron ground the same first 100 spots forever and could
-- never reach position 101. Every museum in the catalogue sits at 237+, which
-- is why none of them ever received a photo despite matching cleanly when
-- probed by hand.
--
-- Recording the attempt is what makes the queue move. Deliberately a separate
-- table rather than a column on `spots`:
--
--   - `spots_touch_updated_at` fires `before update on spots` unqualified, so
--     a column there would bump `updated_at` on every spot each time a lookup
--     failed, destroying the meaning of that column;
--   - the outcome and error detail are operational bookkeeping about a seeding
--     run, not facts about the venue.
-- ============================================================================

create table if not exists spot_photo_attempts (
  spot_id      uuid primary key references spots(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  outcome      text        not null check (outcome in ('attached', 'no_match', 'error')),
  detail       text
);

-- The seeder orders by this to serve never-attempted spots first, then the
-- stalest, so a re-run resumes rather than restarting.
create index if not exists spot_photo_attempts_attempted_idx
  on spot_photo_attempts (attempted_at);

-- Operational bookkeeping, not reference data: RLS on with no policy at all,
-- so only the owner/seeding role can see or write it. The application never
-- reads this table.
alter table spot_photo_attempts enable row level security;
