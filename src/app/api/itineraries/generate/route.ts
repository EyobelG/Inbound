import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db/pool";
import { getAuthedUser } from "@/lib/auth";
import { findTransitMidpointCached } from "@/lib/mbta/midpoint";
import { generateTwoPartDate } from "@/lib/itinerary/generateTwoPartDate";
import { countSpotsNearStations, fetchSpotsByIds } from "@/lib/spots/queries";
import { toErrorResponse } from "@/lib/api/respond";
import { DATE_STAGES, PRICE_TIERS, VIBE_PRIORITIES } from "@/types/domain";

export const dynamic = "force-dynamic";

const GenerateInput = z.object({
  station_a_id: z.string().uuid(),
  station_b_id: z.string().uuid(),
  date_stage: z.enum(DATE_STAGES),
  vibe_priority: z.enum(VIBE_PRIORITIES),
  start_at: z.coerce.date().optional(),
  max_price: z.enum(PRICE_TIERS).optional(),
  radius_meters: z.number().int().min(100).max(1200).default(500),
});

/**
 * POST /api/itineraries/generate
 *
 * The full pipeline: fair meeting station -> spots walkable from it -> ranked
 * two-part pairings. Returns suggestions only; persisting one is a separate,
 * explicit action so a generated route is never silently saved to a profile.
 *
 * Planning works signed-out - only saving requires an account.
 */
export async function POST(request: NextRequest) {
  try {
    const input = GenerateInput.parse(await request.json());
    const user = await getAuthedUser(request);

    const payload = await withUser(user?.uid ?? null, async (client) => {
      const midpoint = await findTransitMidpointCached(
        input.station_a_id,
        input.station_b_id,
        (stationIds, radius) => countSpotsNearStations(client, stationIds, radius),
        { radiusMeters: input.radius_meters, minNearbySpots: 2 },
      );

      const { rows } = await client.query<{ spot_id: string }>(
        `select spot_id from spots_near_station(
             $1, $2,
             null::spot_category[],   -- categories: the matcher does its own split
             null::numeric,           -- max noise
             null::numeric,           -- min lighting
             null::price_tier[],      -- price
             $3, $4)`,
        [midpoint.best.station.id, input.radius_meters, input.date_stage, 60],
      );

      const candidates = await fetchSpotsByIds(client, rows.map((r) => r.spot_id));

      const pairings = generateTwoPartDate(candidates, {
        dateStage: input.date_stage,
        vibePriority: input.vibe_priority,
        startAt: input.start_at ?? new Date(),
        maxPriceTier: input.max_price,
        limit: 8,
      });

      return {
        midpoint: {
          station: midpoint.best.station,
          minutesFromA: Math.round(midpoint.best.minutesFromA),
          minutesFromB: Math.round(midpoint.best.minutesFromB),
          spreadMinutes: Math.round(midpoint.best.spreadMinutes),
        },
        alternatives: midpoint.runnersUp.map((c) => ({
          station: c.station,
          minutesFromA: Math.round(c.minutesFromA),
          minutesFromB: Math.round(c.minutesFromB),
        })),
        pairings,
      };
    });

    return NextResponse.json(payload);
  } catch (error) {
    return toErrorResponse(error);
  }
}
