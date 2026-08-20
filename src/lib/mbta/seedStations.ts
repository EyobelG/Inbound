import type { Pool } from "pg";
import { haversineMeters, parsePoint } from "@/lib/geo";
import type { MbtaLine } from "@/types/domain";

/**
 * Seeds `mbta_stations` and `mbta_transfers` from the MBTA V3 API.
 *
 * Station coordinates are fetched, never hand-written: an approximated lat/lng
 * silently corrupts every ST_DWithin result downstream, and the V3 API is the
 * same source the agency publishes to its own maps.
 *
 * Shared by `npm run seed:stations` and the admin endpoint, because the
 * managed database's connection string is write-only and cannot be used from a
 * local script.
 */
const MBTA_API = "https://api-v3.mbta.com";

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
 * Branch tagging for the two lines that physically split. Without it,
 * `order_index` alone makes the Ashmont and Braintree tips adjacent and the
 * router invents a ride that does not exist.
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

/**
 * Two platforms are the same physical station when they are close together but
 * on different lines. This is how Park Street's Red and Green platforms get a
 * transfer edge without a hand-maintained list.
 */
const TRANSFER_RADIUS_M = 150;
const DEFAULT_TRANSFER_MINUTES = 3;

interface MbtaStop {
  id: string;
  attributes: {
    name: string;
    latitude: number;
    longitude: number;
    wheelchair_boarding: number;
  };
}

async function fetchStops(routeId: string): Promise<MbtaStop[]> {
  const url = new URL(`${MBTA_API}/stops`);
  url.searchParams.set("filter[route]", routeId);

  const headers: Record<string, string> = { Accept: "application/vnd.api+json" };
  if (process.env.MBTA_API_KEY) headers["x-api-key"] = process.env.MBTA_API_KEY;

  const response = await fetch(url, { headers, cache: "no-store" });
  if (!response.ok) {
    throw new Error(`MBTA ${routeId} stops failed: ${response.status}`);
  }
  const body = (await response.json()) as { data: MbtaStop[] };
  return body.data;
}

export interface SeedResult {
  platforms: number;
  transfers: number;
  perLine: Record<string, number>;
}

export async function seedStations(pool: Pool): Promise<SeedResult> {
  const rows: Array<{
    gtfs_stop_id: string;
    stop_name: string;
    line: MbtaLine;
    branch: string | null;
    lng: number;
    lat: number;
    order_index: number;
    is_accessible: boolean;
  }> = [];
  const perLine: Record<string, number> = {};

  for (const [routeId, line] of Object.entries(ROUTE_TO_LINE)) {
    const stops = await fetchStops(routeId);
    perLine[routeId] = stops.length;

    stops.forEach((stop, index) => {
      const { name, latitude, longitude, wheelchair_boarding } = stop.attributes;
      rows.push({
        gtfs_stop_id: stop.id,
        stop_name: name,
        line,
        branch: BRANCH_HEADS[stop.id] ?? null,
        lng: longitude,
        lat: latitude,
        order_index: index,
        is_accessible: wheelchair_boarding === 1,
      });
    });
  }

  // unnest() turns the whole batch into one statement instead of N round trips,
  // and ST_MakePoint builds the geography server-side so no WKT string is ever
  // concatenated from API data.
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
      rows.map((r) => r.lng),
      rows.map((r) => r.lat),
      rows.map((r) => r.order_index),
      rows.map((r) => r.is_accessible),
    ],
  );

  // Rebuild transfer edges from the persisted rows so the ids are real.
  const { rows: persisted } = await pool.query<{
    id: string;
    line: MbtaLine;
    location: unknown;
  }>(`select id, line, st_asgeojson(location)::json as location from mbta_stations`);

  const stations = persisted.map((s) => ({ ...s, point: parsePoint(s.location) }));
  const transfers: Array<{ a: string; b: string }> = [];

  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i]!;
      const b = stations[j]!;
      if (a.line === b.line) continue;
      if (haversineMeters(a.point, b.point) > TRANSFER_RADIUS_M) continue;
      // The table's check constraint requires a canonical ordering.
      const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      transfers.push({ a: lo, b: hi });
    }
  }

  if (transfers.length > 0) {
    await pool.query(
      `insert into mbta_transfers (station_a_id, station_b_id, transfer_minutes)
       select u.a, u.b, $3::numeric
         from unnest($1::uuid[], $2::uuid[]) as u(a, b)
       on conflict (station_a_id, station_b_id) do update set
         transfer_minutes = excluded.transfer_minutes`,
      [transfers.map((t) => t.a), transfers.map((t) => t.b), DEFAULT_TRANSFER_MINUTES],
    );
  }

  return { platforms: rows.length, transfers: transfers.length, perLine };
}
