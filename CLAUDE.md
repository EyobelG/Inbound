# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Next.js dev server
npm run build            # production build (also typechecks + lints)
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:watch
npx vitest run src/lib/itinerary/__tests__/generateTwoPartDate.test.ts   # single file
npx vitest run -t "wraps past midnight"                                  # single test

npm run seed:stations    # MBTA V3 API -> mbta_stations + mbta_transfers
npm run seed:spots -- --subreddit=boston --limit=100
npm run db:migrate       # psql firebase/schema/*.sql against $DATABASE_URL
```

Tests are Node-environment vitest with a `@/` alias declared in `vitest.config.ts`
(separate from `tsconfig.json` — a new alias must be added to both).

## Stack

Firebase Auth for identity; **Cloud SQL for PostgreSQL + PostGIS** for data,
accessed server-side with `pg`.

The database is the Cloud SQL instance that Firebase Data Connect provisions,
but we do **not** use Data Connect's generated GraphQL SDK. Its schema language
cannot express PostGIS types, custom functions, triggers, or RLS policies, and
all four are load-bearing here — so `firebase/schema/*.sql` is applied directly
with psql and queried directly with `pg`. Data Connect's SDK remains a fine fit
for plain CRUD if that gets added; both talk to the same database.

## Architecture

Inbound generates two-stop date itineraries anchored to a *fair* MBTA meeting
station. One request flows through three stages, and each stage owns a distinct
concern:

1. **`findTransitMidpoint`** (`src/lib/mbta/midpoint.ts`) — where to meet.
2. **`spots_near_station`** (Postgres function) — what is walkable from there.
3. **`generateTwoPartDate`** (`src/lib/itinerary/generateTwoPartDate.ts`) — which
   pair of stops to propose.

`POST /api/itineraries/generate` is the only place all three are wired together.

### The transit graph

A graph **node is a line-platform, not a station**. Park Street contributes a
Red node and a Green node joined by a row in `mbta_transfers`. This is what lets
the router charge for a transfer instead of teleporting riders between lines,
and it is why most code paths group by `gtfs_stop_id` before showing results to
a user (`graph.byGtfsId`, `collapseToPhysicalStations`, `StationCombobox`).

Adjacency is `same line && |order_index delta| == 1 && branch-compatible`. The
`branch` column exists solely because the Red Line (Ashmont/Braintree) and Green
Line split — without it, `order_index` alone makes the two branch tips adjacent
and the router invents a ride that does not exist. There is a regression test
for this in `src/lib/mbta/__tests__/graph.test.ts`.

The graph is loaded once and cached (`loadTransitGraph`), then Dijkstra runs
from each origin over ~150 nodes. It is exhaustive, not heuristic — the network
is small enough that approximating buys nothing.

### Scoring is weighted, and the weights encode product decisions

Two scoring functions carry the product thesis. Change the weights only
deliberately:

- **Midpoint** (`midpoint.ts`): `SPREAD_WEIGHT > TOTAL_WEIGHT`, so fairness beats
  efficiency — 22/22 minutes wins over 8/32. Spot density is a capped tiebreak,
  never a driver.
- **Pairing** (`generateTwoPartDate.ts`): Step 1 is a low-stakes opener
  (`cafe`/`bar`) and Step 2 is the commitment (`restaurant`/`activity`/
  `dessert`/`walk_park`). The category split is not cosmetic — never let a
  90-minute dinner be proposed as a first stop. `easy_exit_score` only earns
  weight on `first_date`.

Missing crowd data is **neutral (0.5), never disqualifying**, and `confidence()`
damps scores built on one or two reviews. Cold-start inventory has to be
reachable or the product never bootstraps; the same rule appears in the SQL
(`v.avg_noise_level is null or ...` in `spots_near_station`).

### Auth and RLS

Supabase supplied `auth.uid()` to RLS automatically. On plain Cloud SQL nothing
does, so the app is responsible for it, and the chain is exact:

`Authorization: Bearer <Firebase ID token>` → `getAuthedUser` verifies it via
firebase-admin → `withUser(uid, fn)` opens a transaction and `SET LOCAL
app.firebase_uid` → the policies in `0003_rls.sql` read it through
`current_firebase_uid()`.

- **`withUser` in `src/lib/db/pool.ts` is the only place permitted to set
  `app.firebase_uid`**, and the uid must come from a *verified* token — never
  from a request body or header field. `SET LOCAL` scopes it to the transaction
  so a pooled connection cannot leak one user's identity into the next request.
- **The runtime role must not own the tables.** RLS does not apply to table
  owners or superusers, so connecting as the migration role silently disables
  every policy. `DATABASE_URL` must use the non-owner `inbound_app` role created
  at the bottom of `0003_rls.sql`.
- `auth.users` is gone; `app_users` is the local projection of Firebase identity
  that user-owned foreign keys point at. `firebase_uid` is a **text** uid, not a
  UUID. `ensureAppUser` upserts it inside the same transaction as a user's first
  write, so identity and content commit together.

### Database invariants

- **`spot_vibes` is trigger-maintained and never written by application code.**
  `recalc_spot_vibes` re-aggregates from `user_reviews` on every write. It
  recomputes in full rather than applying a delta because deltas drift on UPDATE
  and DELETE. There is deliberately no RLS write policy on that table, so direct
  client writes are denied by default.
- **`nearest_station_id` / `walking_minutes_to_t` are trigger-derived** from the
  geometry (`attach_nearest_station`). Seeders must not set them.
- Walking time = straight-line × `STREET_DETOUR_FACTOR` (1.35) ÷ 80 m/min. This
  constant is duplicated in `src/lib/geo.ts` and in the SQL helpers — **change
  both together**.
- `is_verified = false` is the default for seeded rows and search only returns
  verified spots (`spots_verified_idx` is a partial index on that predicate).
  Seeding produces leads; a human flips the flag.
- RLS posture: reference data is world-readable, user-generated rows are
  writable only by their author. Seed scripts connect as the owner role and so
  bypass RLS by design; never point application code at that role.

### Conventions

- `src/types/domain.ts` string unions mirror the Postgres enums in
  `firebase/schema/0001_schema.sql` exactly. Changing one means changing both.
- Read geometry as `st_asgeojson(location)::json` and write it with
  `st_setsrid(st_makepoint($lng, $lat), 4326)` — never concatenate a WKT string
  from API data. `parsePoint` in `src/lib/geo.ts` handles both shapes on the way
  back.
- node-postgres returns `numeric` as a **string** to avoid float64 precision
  loss. Vibe scores must go through `Number()` on hydration or comparisons
  silently become lexicographic.
- MBTA line colors live in `src/lib/mbta/colors.ts`; `tailwind.config.ts` imports
  from there. Never redeclare a hex — a chip and its map polyline must not drift.
- The map is **MapLibre GL + OpenFreeMap**, deliberately keyless — import from
  `react-map-gl/maplibre`, not `react-map-gl`. Don't reintroduce a token gate:
  the map must render on a fresh clone. `NEXT_PUBLIC_MAP_STYLE` overrides the
  basemap if a self-hosted or paid style is ever needed.
- **`maplibre-gl` is pinned to v3.** react-map-gl 7.x does not actually work
  with maplibre-gl v4 even though its peer range allows `<5.0.0`: the style and
  TileJSON load fine and nothing throws, but the vector source never requests
  tiles, so you get overlays floating on an empty background. Upgrading past v3
  requires moving to react-map-gl v8 and re-verifying that basemap tiles render
  — a passing build proves nothing here.
- Route handlers stay thin: validate with zod, call into `src/lib`, and funnel
  every throw through `toErrorResponse` (`src/lib/api/respond.ts`), which is the
  single error→HTTP translation point. `DomainError` codes map to statuses there.
- Cache helpers in `src/lib/cache.ts` degrade to a direct loader call when
  Upstash is unconfigured or failing. A cache outage must never take down search.

## Setup

Copy `.env.example` to `.env.local`. `DATABASE_URL` is the only required value;
the app boots and renders with none of the rest set — the home page shows its
own setup instructions rather than a 500. Keep that property when touching
`page.tsx`: guard on `isDatabaseConfigured()` rather than letting a missing env
var throw.

`./scripts/local-db.sh start` runs a local Postgres 18 + PostGIS cluster on port
55433 (Homebrew only builds PostGIS for PG 17/18, which is why it pins @18), and
`npm run seed:demo` fills it with fictional spots so the full pipeline can be
exercised without a Google Places key.

`FIREBASE_SERVICE_ACCOUNT_KEY` and `GOOGLE_PLACES_API_KEY` are server-only.
Google photo resources are proxied through `/api/photos/...` specifically so the
key never reaches the browser; that route validates the resource name against a
strict pattern because otherwise it is an open redirect.
