import {
  loadTransitGraph,
  resolveStation,
  shortestTimes,
  type TransitGraph,
} from "@/lib/mbta/graph";
import { cached, cacheKey, CACHE_TTL } from "@/lib/cache";
import { DomainError, type Station } from "@/types/domain";

export interface MidpointCandidate {
  station: Station;
  /** Door-to-platform ride time for each party, in minutes. */
  minutesFromA: number;
  minutesFromB: number;
  /** The unfairness both parties actually feel. Lower is better. */
  spreadMinutes: number;
  totalMinutes: number;
  /** Verified spots within the walk radius. Zero means nothing to do there. */
  nearbySpotCount: number;
  score: number;
}

export interface MidpointResult {
  origins: { a: Station; b: Station };
  best: MidpointCandidate;
  runnersUp: MidpointCandidate[];
}

export interface MidpointOptions {
  /** Walk radius used when counting what there is to do at a candidate hub. */
  radiusMeters?: number;
  /** Reject hubs with fewer than this many verified spots. */
  minNearbySpots?: number;
  /** How many alternatives to return alongside the winner. */
  alternatives?: number;
}

/**
 * Scoring weights.
 *
 * Fairness dominates: a hub that costs one person 8 minutes and the other 32
 * is a worse meeting point than one costing both 22, even though the totals
 * match. `SPREAD_WEIGHT > TOTAL_WEIGHT` encodes exactly that. The spot-density
 * term is a mild tiebreak, not a driver - it separates Downtown Crossing from
 * an equidistant hub with nothing around it, without ever overriding a large
 * fairness gap.
 */
const SPREAD_WEIGHT = 1.0;
const TOTAL_WEIGHT = 0.35;
const DENSITY_BONUS_PER_SPOT = 0.4;
const MAX_DENSITY_BONUS = 8;

function scoreCandidate(
  minutesFromA: number,
  minutesFromB: number,
  nearbySpotCount: number,
): number {
  const spread = Math.abs(minutesFromA - minutesFromB);
  const total = minutesFromA + minutesFromB;
  const densityBonus = Math.min(
    MAX_DENSITY_BONUS,
    nearbySpotCount * DENSITY_BONUS_PER_SPOT,
  );
  return SPREAD_WEIGHT * spread + TOTAL_WEIGHT * total - densityBonus;
}

/**
 * Every line-platform sharing a physical station is one meeting point. Collapse
 * them to the cheapest platform so Park Street doesn't occupy four result slots.
 */
function collapseToPhysicalStations(
  graph: TransitGraph,
  fromA: Map<string, { minutes: number }>,
  fromB: Map<string, { minutes: number }>,
): Array<{ station: Station; minutesFromA: number; minutesFromB: number }> {
  const best = new Map<
    string,
    { station: Station; minutesFromA: number; minutesFromB: number }
  >();

  for (const [nodeId, node] of graph.nodes) {
    const a = fromA.get(nodeId);
    const b = fromB.get(nodeId);
    if (!a || !b) continue; // unreachable for one party

    const key = node.station.gtfsStopId;
    const candidate = {
      station: node.station,
      minutesFromA: a.minutes,
      minutesFromB: b.minutes,
    };
    const incumbent = best.get(key);
    if (
      !incumbent ||
      candidate.minutesFromA + candidate.minutesFromB <
        incumbent.minutesFromA + incumbent.minutesFromB
    ) {
      best.set(key, candidate);
    }
  }

  return [...best.values()];
}

type SpotCounter = (stationIds: string[], radiusMeters: number) => Promise<Map<string, number>>;

/**
 * Finds the fairest station for two people starting from different lines.
 *
 * Runs Dijkstra once from each origin over the whole network, then scores every
 * station reachable by both. This is exhaustive rather than heuristic - the
 * subway is ~150 nodes, so there is no reason to approximate.
 */
export async function findTransitMidpoint(
  originAId: string,
  originBId: string,
  countNearbySpots: SpotCounter,
  options: MidpointOptions = {},
): Promise<MidpointResult> {
  const {
    radiusMeters = 400,
    minNearbySpots = 1,
    alternatives = 4,
  } = options;

  if (originAId === originBId) {
    throw new DomainError(
      "Both parties selected the same station - no midpoint needed.",
      "INVALID_INPUT",
    );
  }

  const graph = await loadTransitGraph();
  const stationA = resolveStation(graph, originAId);
  const stationB = resolveStation(graph, originBId);

  // Start from every platform at the origin: someone at Park Street can board
  // Red or Green, and forcing one costs a phantom transfer.
  const originsA = graph.byGtfsId.get(stationA.gtfsStopId) ?? [stationA.id];
  const originsB = graph.byGtfsId.get(stationB.gtfsStopId) ?? [stationB.id];

  const fromA = shortestTimes(graph, originsA);
  const fromB = shortestTimes(graph, originsB);

  const reachable = collapseToPhysicalStations(graph, fromA, fromB);
  if (reachable.length === 0) {
    throw new DomainError(
      `No station is reachable from both ${stationA.stopName} and ${stationB.stopName}.`,
      "NO_ROUTE",
    );
  }

  // One batched count for the plausible shortlist instead of a query per
  // station: rank by fairness first, then only price the top slice.
  const shortlist = reachable
    .sort(
      (x, y) =>
        scoreCandidate(x.minutesFromA, x.minutesFromB, 0) -
        scoreCandidate(y.minutesFromA, y.minutesFromB, 0),
    )
    .slice(0, 25);

  const counts = await countNearbySpots(
    shortlist.map((c) => c.station.id),
    radiusMeters,
  );

  const scored: MidpointCandidate[] = shortlist
    .map((candidate) => {
      const nearbySpotCount = counts.get(candidate.station.id) ?? 0;
      return {
        ...candidate,
        nearbySpotCount,
        spreadMinutes: Math.abs(candidate.minutesFromA - candidate.minutesFromB),
        totalMinutes: candidate.minutesFromA + candidate.minutesFromB,
        score: scoreCandidate(
          candidate.minutesFromA,
          candidate.minutesFromB,
          nearbySpotCount,
        ),
      };
    })
    .filter((c) => c.nearbySpotCount >= minNearbySpots)
    .sort((x, y) => x.score - y.score);

  const best = scored[0];
  if (!best) {
    throw new DomainError(
      "Found reachable stations, but none had verified spots nearby. Widen the radius.",
      "NO_CANDIDATES",
    );
  }

  return {
    origins: { a: stationA, b: stationB },
    best,
    runnersUp: scored.slice(1, 1 + alternatives),
  };
}

/** Cached wrapper. Midpoints are a pure function of the graph and the radius. */
export async function findTransitMidpointCached(
  originAId: string,
  originBId: string,
  countNearbySpots: SpotCounter,
  options: MidpointOptions = {},
): Promise<MidpointResult> {
  const key = `${cacheKey.midpoint(originAId, originBId)}:${options.radiusMeters ?? 400}`;
  return cached(key, CACHE_TTL.midpoint, () =>
    findTransitMidpoint(originAId, originBId, countNearbySpots, options),
  );
}
