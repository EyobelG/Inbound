import { query } from "@/lib/db/pool";
import { cached, cacheKey, CACHE_TTL } from "@/lib/cache";
import { haversineMeters, parsePoint } from "@/lib/geo";
import { DomainError, type MbtaLine, type Station } from "@/types/domain";

/**
 * A node is a line-platform, not a place: Park Street has a Red node and a
 * Green node joined by a transfer edge. Modelling it this way is what lets the
 * router charge for a transfer instead of teleporting riders between lines.
 */
export interface GraphNode {
  station: Station;
  edges: GraphEdge[];
}

export interface GraphEdge {
  toStationId: string;
  minutes: number;
  kind: "ride" | "transfer";
}

export interface TransitGraph {
  nodes: Map<string, GraphNode>;
  /** gtfs_stop_id -> every line-platform at that physical station. */
  byGtfsId: Map<string, string[]>;
}

/** Average subway speed including dwell, m/min. Calibrated against MBTA V3 travel times. */
const TRAIN_SPEED_M_PER_MIN = 550;
/** Floor: no two adjacent stops are less than this apart in practice. */
const MIN_HOP_MINUTES = 1.5;

interface StationRow extends Record<string, unknown> {
  id: string;
  gtfs_stop_id: string;
  stop_name: string;
  line: MbtaLine;
  branch: string | null;
  order_index: number;
  is_accessible: boolean;
  location: unknown;
}

interface TransferRow extends Record<string, unknown> {
  station_a_id: string;
  station_b_id: string;
  transfer_minutes: number;
}

function rideMinutes(a: Station, b: Station): number {
  const meters = haversineMeters(a.location, b.location);
  return Math.max(MIN_HOP_MINUTES, meters / TRAIN_SPEED_M_PER_MIN);
}

/**
 * Two stations on the same line are adjacent iff their order_index differs by
 * one AND they share a branch (or at least one of them sits on the shared
 * trunk, where `branch` is null). Without the branch guard, Ashmont would come
 * out adjacent to Braintree and the router would invent a nonexistent ride.
 */
function isAdjacent(a: Station, b: Station): boolean {
  if (a.line !== b.line) return false;
  if (Math.abs(a.orderIndex - b.orderIndex) !== 1) return false;
  if (a.branch === null || b.branch === null) return true;
  return a.branch === b.branch;
}

export function buildGraph(
  stations: Station[],
  transfers: Array<{ a: string; b: string; minutes: number }>,
): TransitGraph {
  const nodes = new Map<string, GraphNode>();
  const byGtfsId = new Map<string, string[]>();

  for (const station of stations) {
    nodes.set(station.id, { station, edges: [] });
    const siblings = byGtfsId.get(station.gtfsStopId) ?? [];
    siblings.push(station.id);
    byGtfsId.set(station.gtfsStopId, siblings);
  }

  // Ride edges, bucketed by line so this stays O(n) per line rather than O(n^2).
  const byLine = new Map<MbtaLine, Station[]>();
  for (const station of stations) {
    const bucket = byLine.get(station.line) ?? [];
    bucket.push(station);
    byLine.set(station.line, bucket);
  }

  for (const bucket of byLine.values()) {
    bucket.sort((x, y) => x.orderIndex - y.orderIndex);
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i]!;
      // A trunk station can be adjacent to several branch heads, so scan
      // forward past the immediate neighbour until order_index outruns +1.
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j]!;
        if (b.orderIndex - a.orderIndex > 1) break;
        if (!isAdjacent(a, b)) continue;
        const minutes = rideMinutes(a, b);
        nodes.get(a.id)!.edges.push({ toStationId: b.id, minutes, kind: "ride" });
        nodes.get(b.id)!.edges.push({ toStationId: a.id, minutes, kind: "ride" });
      }
    }
  }

  for (const { a, b, minutes } of transfers) {
    if (!nodes.has(a) || !nodes.has(b)) continue;
    nodes.get(a)!.edges.push({ toStationId: b, minutes, kind: "transfer" });
    nodes.get(b)!.edges.push({ toStationId: a, minutes, kind: "transfer" });
  }

  return { nodes, byGtfsId };
}

/**
 * Loads and caches the graph. The station table is reference data that changes
 * on the order of once a year, so a 24h TTL is generous rather than risky.
 */
export async function loadTransitGraph(): Promise<TransitGraph> {
  const serialized = await cached(
    cacheKey.stationGraph(),
    CACHE_TTL.stationGraph,
    async () => {
      // The station graph is public reference data, so this reads outside any
      // per-user transaction - there is no row here that RLS would hide.
      const [stationRows, transferRows] = await Promise.all([
        query<StationRow>(
          `select id, gtfs_stop_id, stop_name, line, branch, order_index,
                  is_accessible, st_asgeojson(location)::json as location
             from mbta_stations`,
        ),
        query<TransferRow>(
          `select station_a_id, station_b_id, transfer_minutes from mbta_transfers`,
        ),
      ]);

      const stations: Station[] = stationRows.map((row) => ({
        id: row.id,
        gtfsStopId: row.gtfs_stop_id,
        stopName: row.stop_name,
        line: row.line,
        branch: row.branch,
        orderIndex: row.order_index,
        isAccessible: row.is_accessible,
        location: parsePoint(row.location),
      }));

      const transfers = transferRows.map((row) => ({
        a: row.station_a_id,
        b: row.station_b_id,
        minutes: Number(row.transfer_minutes),
      }));

      return { stations, transfers };
    },
  );

  if (serialized.stations.length === 0) {
    throw new DomainError(
      "Station graph is empty - run `npm run seed:stations`.",
      "STATION_NOT_FOUND",
    );
  }

  return buildGraph(serialized.stations, serialized.transfers);
}

/**
 * Single-source shortest path over the graph. The network is ~150 nodes with
 * degree <= 4, so a linear-scan frontier beats the constant factor of a real
 * binary heap and keeps this dependency-free.
 */
export function shortestTimes(
  graph: TransitGraph,
  originIds: string[],
): Map<string, { minutes: number; previous: string | null }> {
  const dist = new Map<string, { minutes: number; previous: string | null }>();
  const visited = new Set<string>();

  for (const id of originIds) {
    if (graph.nodes.has(id)) dist.set(id, { minutes: 0, previous: null });
  }

  while (true) {
    let currentId: string | null = null;
    let currentMinutes = Infinity;

    for (const [id, entry] of dist) {
      if (visited.has(id)) continue;
      if (entry.minutes < currentMinutes) {
        currentMinutes = entry.minutes;
        currentId = id;
      }
    }

    if (currentId === null) break;
    visited.add(currentId);

    for (const edge of graph.nodes.get(currentId)!.edges) {
      const candidate = currentMinutes + edge.minutes;
      const known = dist.get(edge.toStationId);
      if (!known || candidate < known.minutes) {
        dist.set(edge.toStationId, { minutes: candidate, previous: currentId });
      }
    }
  }

  return dist;
}

export function resolveStation(graph: TransitGraph, idOrGtfsId: string): Station {
  const direct = graph.nodes.get(idOrGtfsId);
  if (direct) return direct.station;

  const siblings = graph.byGtfsId.get(idOrGtfsId);
  const first = siblings?.[0];
  if (first) return graph.nodes.get(first)!.station;

  throw new DomainError(`Unknown station: ${idOrGtfsId}`, "STATION_NOT_FOUND");
}
