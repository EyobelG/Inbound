/**
 * Seeds `mbta_stations` and `mbta_transfers` from the MBTA V3 API.
 *
 * Station coordinates are fetched, never hand-written: an approximated lat/lng
 * silently corrupts every ST_DWithin result downstream, and the V3 API is the
 * same source the agency publishes to its own maps.
 *
 *   npm run seed:stations
 */
import { getPool } from "../src/lib/db/pool";
import { haversineMeters } from "../src/lib/geo";
import type { MbtaLine } from "../src/types/domain";

const MBTA_API = "https://api-v3.mbta.com";

/** MBTA route id -> our `mbta_line` enum. */
const ROUTE_TO_LINE: Record<string, MbtaLine> = {
  Red: "red",
  Orange: "orange",
  Blue: "blue",
  "Green-B": "green_b",
  "Green-C": "green_c",
  "Green-D": "green_d",
  "Green-E": "green_e",
};

/**
 * Branch tagging for the two lines that physically split. The API returns one
 * ordered stop list per direction per route pattern; we tag the tips so the
 * graph builder does not treat Ashmont and Braintree as adjacent.
 */
const BRANCH_HEADS: Record<string, string> = {
  "place-shmnl": "ashmont",
  "place-fldcr": "ashmont",
  "place-smmnl": "ashmont",
  "place-asmnl": "ashmont",
  "place-nqncy": "braintree",
  "place-wlsta": "braintree",
  "place-qnctr": "braintree",
  "place-qamnl": "braintree",
  "place-brntn": "braintree",
};

interface MbtaStop {
  id: string;
  attributes: { name: string; latitude: number; longitude: number; wheelchair_boarding: number };
}

async function fetchStops(routeId: string): Promise<MbtaStop[]> {
  const url = new URL(`${MBTA_API}/stops`);
  url.searchParams.set("filter[route]", routeId);
  url.searchParams.set("include", "route");

  const headers: Record<string, string> = { Accept: "application/vnd.api+json" };
  if (process.env.MBTA_API_KEY) headers["x-api-key"] = process.env.MBTA_API_KEY;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`MBTA ${routeId} stops failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { data: MbtaStop[] };
  return body.data;
}

/**
 * Two platforms are the same physical station when they are within 150m of
 * each other but belong to different lines. This is how Park Street's Red and
 * Green platforms get a transfer edge without a hand-maintained list.
 */
const TRANSFER_RADIUS_M = 150;
const DEFAULT_TRANSFER_MINUTES = 3;

async function main() {
  // Seeding connects as the migration/owner role, which owns these tables and
  // therefore bypasses RLS - reference data has no per-user write policy.
  const pool = getPool();

  const rows: Array<{
    gtfs_stop_id: string;
    stop_name: string;
    line: MbtaLine;
    branch: string | null;
    longitude: number;
    latitude: number;
    order_index: number;
    is_accessible: boolean;
  }> = [];

  for (const [routeId, line] of Object.entries(ROUTE_TO_LINE)) {
    const stops = await fetchStops(routeId);
    console.log(`${routeId}: ${stops.length} stops`);

    stops.forEach((stop, index) => {
      const { name, latitude, longitude, wheelchair_boarding } = stop.attributes;
      rows.push({
        gtfs_stop_id: stop.id,
        stop_name: name,
        line,
        branch: BRANCH_HEADS[stop.id] ?? null,
        longitude,
        latitude,
        order_index: index,
        is_accessible: wheelchair_boarding === 1,
      });
    });

    // Courtesy pacing: the unauthenticated tier is 20 req/min.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // unnest() turns the whole batch into one statement instead of N round
  // trips, and ST_MakePoint builds the geography server-side so no WKT string
  // is ever concatenated from API data.
  await pool.query(
    `insert into mbta_stations
       (gtfs_stop_id, stop_name, line, branch, location, order_index, is_accessible)
     select u.gtfs_stop_id, u.stop_name, u.line::mbta_line, u.branch,
            st_setsrid(st_makepoint(u.lng, u.lat), 4326)::geography,
            u.order_index, u.is_accessible
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[],
                   $6::float8[], $7::int[], $8::boolean[])
         as u(gtfs_stop_id, stop_name, line, branch, lng, lat, order_index, is_accessible)
     on conflict (gtfs_stop_id, line) do update set
       stop_name     = excluded.stop_name,
       branch        = excluded.branch,
       location      = excluded.location,
       order_index   = excluded.order_index,
       is_accessible = excluded.is_accessible`,
    [
      rows.map((r) => r.gtfs_stop_id),
      rows.map((r) => r.stop_name),
      rows.map((r) => r.line),
      rows.map((r) => r.branch),
      rows.map((r) => r.longitude),
      rows.map((r) => r.latitude),
      rows.map((r) => r.order_index),
      rows.map((r) => r.is_accessible),
    ],
  );
  console.log(`Upserted ${rows.length} station platforms.`);

  // Rebuild transfer edges from the persisted rows so ids are real.
  const { parsePoint } = await import("../src/lib/geo");
  const { rows: persisted } = await pool.query<{
    id: string;
    gtfs_stop_id: string;
    line: MbtaLine;
    location: unknown;
  }>(
    `select id, gtfs_stop_id, line, st_asgeojson(location)::json as location
       from mbta_stations`,
  );
  const stations = persisted.map((s) => ({ ...s, point: parsePoint(s.location) }));

  const transfers: Array<{ station_a_id: string; station_b_id: string; transfer_minutes: number }> = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i]!;
      const b = stations[j]!;
      if (a.line === b.line) continue;
      if (haversineMeters(a.point, b.point) > TRANSFER_RADIUS_M) continue;

      // The table's check constraint requires a canonical ordering.
      const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      transfers.push({
        station_a_id: lo,
        station_b_id: hi,
        transfer_minutes: DEFAULT_TRANSFER_MINUTES,
      });
    }
  }

  if (transfers.length > 0) {
    await pool.query(
      `insert into mbta_transfers (station_a_id, station_b_id, transfer_minutes)
       select * from unnest($1::uuid[], $2::uuid[], $3::numeric[])
       on conflict (station_a_id, station_b_id) do update set
         transfer_minutes = excluded.transfer_minutes`,
      [
        transfers.map((t) => t.station_a_id),
        transfers.map((t) => t.station_b_id),
        transfers.map((t) => t.transfer_minutes),
      ],
    );
  }
  console.log(`Upserted ${transfers.length} transfer edges.`);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
