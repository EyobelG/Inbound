# Inbound

Transit-aware date planning for Boston, Cambridge, and Somerville. Two people
pick the stations they're coming from; Inbound finds a *fair* meeting stop on
the MBTA and proposes two-stop itineraries built from crowdsourced vibe data —
noise, lighting, how easy it is to leave, and which date stage a place actually
suits.

## Why a midpoint, not a middle

Splitting the difference geographically is the wrong answer on a radial subway
network: the geographic midpoint of Davis and Coolidge Corner is a spot with no
station. Inbound runs Dijkstra from both origins over the real line graph and
ranks stations by *fairness first* — a hub costing both people 22 minutes beats
one costing 8 and 32, even though the totals match.

## Stack

Next.js 15 (App Router, React 19) · Firebase Auth · Cloud SQL for PostgreSQL +
PostGIS via `pg` · MapLibre GL + OpenFreeMap · Upstash Redis (optional).

The basemap needs **no API key**. MapLibre GL is the open-source fork of Mapbox
GL JS, and OpenFreeMap serves vector tiles free and unmetered, so the map works
on a fresh clone with nothing configured. Set `NEXT_PUBLIC_MAP_STYLE` to any
other MapLibre style URL to override it.

## Getting started

`DATABASE_URL` is the only value you must set. Everything else degrades
gracefully — the app boots and renders its own setup instructions rather than
erroring.

### Local development, no cloud accounts needed

Requires `brew install postgresql@18 postgis` (PostGIS is only built for
Postgres 17/18 on Homebrew).

```bash
npm install
cp .env.example .env.local
./scripts/local-db.sh start    # Postgres + PostGIS on port 55433
npm run db:migrate             # apply firebase/schema/*.sql
npm run seed:stations          # 147 real station platforms from the MBTA V3 API
npm run seed:demo              # fictional spots, so the pipeline has inventory
npm run dev
```

`scripts/local-db.sh` also takes `stop`, `status`, `reset`, and `psql`.

### Against a real database

```bash
cp .env.example .env.local     # set DATABASE_URL to your Cloud SQL instance
npm run db:migrate
npm run seed:stations
npm run seed:spots -- --subreddit=boston --limit=100   # needs GOOGLE_PLACES_API_KEY
```

Create the runtime role first, and make sure it is **not** the table owner —
RLS does not apply to owners, so an owner connection silently ignores every
policy:

```sql
create role inbound_app login password '...';
grant usage on schema public to inbound_app;
```

Spots from `seed:spots` land with `is_verified = false` and stay invisible to
search until a human flips the flag. That's deliberate: an extracted venue name
is a lead, not a fact. `seed:demo` bypasses this with clearly-labelled fictional
data for local use only.

## Layout

```
firebase/schema/       schema, spatial helpers + triggers, RLS
src/lib/db/            pg pool + the withUser() RLS transaction helper
src/lib/firebase/      Auth: admin token verification, client SDK
src/lib/mbta/          station graph, Dijkstra, midpoint scoring
src/lib/itinerary/     two-part pairing, opening-hours logic
src/lib/spots/         query + row-to-domain mapping
src/app/api/           route handlers (spots/search, reviews/submit, itineraries/generate)
src/components/        map, spot card, planner bar
scripts/               MBTA + cold-start Reddit/Places seeders
```

See `CLAUDE.md` for architecture notes and the invariants worth knowing before
changing scoring or schema.

## Deploying

Firebase App Hosting, in the same project as Auth and the Cloud SQL instance.
Config is in `apphosting.yaml`; fill in the four `your-*` placeholders with your
real project values first.

```bash
npx firebase login
npx firebase apphosting:secrets:set DATABASE_URL
npx firebase apphosting:secrets:set MBTA_API_KEY
npx firebase apphosting:secrets:set GOOGLE_PLACES_API_KEY
npx firebase apphosting:secrets:set UPSTASH_REDIS_REST_TOKEN
npx firebase apphosting:backends:create --project <your-project-id>
```

Two things that bite on first deploy:

- **`DATABASE_URL` must use the non-owner `inbound_app` role.** RLS does not
  apply to table owners, so an owner connection silently ignores every policy
  in `0003_rls.sql` — the app will appear to work while enforcing nothing.
- **`maxInstances` × `PGPOOL_MAX` must stay under your Cloud SQL connection
  limit.** The defaults (4 × 5 = 20) fit under the ~25 a shared-core
  db-f1-micro allows, with headroom for migrations and a psql session. Raise
  the database tier before raising either number — exhausting connections
  fails as timeouts under load, not as a clear error.

No service account key is needed anywhere — the backend runs with Application
Default Credentials, which is why `FIREBASE_SERVICE_ACCOUNT_KEY` is absent from
`apphosting.yaml`. It stays in `.env.local` for local development only.

## Tests

```bash
npm test
```

Covers the graph's branch handling (Ashmont must never be adjacent to
Braintree), transfer penalties, pairing constraints and ranking, and the
past-midnight opening-hours case that bars depend on.
