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

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in Supabase, Mapbox, MBTA, Google keys
npm run db:push                # apply supabase/migrations
npm run seed:stations          # station graph from the MBTA V3 API
npm run seed:spots -- --subreddit=boston --limit=100
npm run dev
```

Seeded spots land with `is_verified = false` and are invisible to search until
reviewed. That's deliberate: an extracted venue name is a lead, not a fact.

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
npx firebase apphosting:secrets:set MAPBOX_TOKEN
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
  limit.** The defaults (10 × 5 = 50) fit a db-f1-micro; raise the instance tier
  before raising either number.

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
