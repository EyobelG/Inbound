-- ---------------------------------------------------------------------------
-- 0004_wikimedia_photos
--
-- Adds Wikimedia Commons as a third photo source.
--
-- Cold-start inventory needs imagery before anyone has uploaded a community
-- photo, and Google Places photos require a billed API key. Commons is keyless
-- and openly licensed, so it is what makes a fresh database look populated.
--
-- The cost of that licensing is attribution: CC-BY / CC-BY-SA images may only
-- be displayed alongside the author, the licence, and a link back to the file
-- page. Those three columns are therefore NOT NULL for wikimedia rows, enforced
-- by the same CHECK that already forces community uploads to name an uploader -
-- an unattributed Commons image is a licence violation, not a cosmetic gap.
-- ---------------------------------------------------------------------------

alter type photo_source add value if not exists 'wikimedia';

alter table spot_photos add column if not exists attribution     text;
alter table spot_photos add column if not exists license         text;
alter table spot_photos add column if not exists source_page_url text;

-- The 0001 constraint is unnamed, so it is located by definition rather than by
-- a name that differs between databases.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
   where rel.relname = 'spot_photos'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%community_upload%';

  if constraint_name is not null then
    execute format('alter table spot_photos drop constraint %I', constraint_name);
  end if;
end $$;

alter table spot_photos add constraint spot_photos_source_provenance check (
  (source = 'community_upload' and uploaded_by_user_id is not null)
  or source = 'google_places'
  or (
    source = 'wikimedia'
    and attribution     is not null
    and license         is not null
    and source_page_url is not null
  )
);

-- Makes the seeder idempotent: re-running it updates the existing row for a
-- file instead of stacking duplicates of the same photo on a spot.
create unique index if not exists spot_photos_spot_url_idx
  on spot_photos (spot_id, url);
