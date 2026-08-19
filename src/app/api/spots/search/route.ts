import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db/pool";
import { getAuthedUser } from "@/lib/auth";
import { attachTopQuotes, mapSpotRow, SPOT_SELECT } from "@/lib/spots/queries";
import { cached, cacheKey, CACHE_TTL } from "@/lib/cache";
import { toErrorResponse } from "@/lib/api/respond";
import {
  DATE_STAGES,
  PRICE_TIERS,
  SPOT_CATEGORIES,
  VIBE_PRIORITIES,
  type VibePriority,
} from "@/types/domain";

export const dynamic = "force-dynamic";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1))
    .optional();

const SearchParams = z.object({
  station_id: z.string().uuid(),
  max_walk_distance: z.coerce.number().int().min(50).max(2000).default(400),
  category: csv(SPOT_CATEGORIES),
  price: csv(PRICE_TIERS),
  date_stage: z.enum(DATE_STAGES).optional(),
  vibe: z.enum(VIBE_PRIORITIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * A vibe priority is a pair of thresholds on the aggregate metrics, not a tag
 * lookup - that way a spot qualifies on what reviewers actually measured.
 */
const VIBE_THRESHOLDS: Record<VibePriority, { maxNoise?: number; minLighting?: number }> = {
  quiet_convo:  { maxNoise: 2.8 },
  fun_activity: {},
  romantic_dim: { maxNoise: 3.5 },
};

interface NearbyRow {
  spot_id: string;
  distance_meters: string;
  walking_minutes: number;
}

/**
 * GET /api/spots/search
 *   ?station_id=<uuid>&max_walk_distance=400&category=bar,cafe
 *   &price=$,$$&date_stage=first_date&vibe=quiet_convo
 */
export async function GET(request: NextRequest) {
  try {
    const params = SearchParams.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const thresholds = params.vibe ? VIBE_THRESHOLDS[params.vibe] : {};
    // Search serves signed-out visitors too; an anonymous uid simply matches no
    // ownership policy, and every table read here is public anyway.
    const user = await getAuthedUser(request);

    const spots = await withUser(user?.uid ?? null, async (client) => {
      const nearby = await cached(
        cacheKey.spotSearch(JSON.stringify(params)),
        CACHE_TTL.spotSearch,
        async () => {
          const { rows } = await client.query<NearbyRow>(
            `select spot_id, distance_meters, walking_minutes
               from spots_near_station($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              params.station_id,
              params.max_walk_distance,
              params.category ?? null,
              thresholds.maxNoise ?? null,
              thresholds.minLighting ?? null,
              params.price ?? null,
              params.date_stage ?? null,
              params.limit,
            ],
          );
          return rows;
        },
      );

      if (nearby.length === 0) return [];

      const ids = nearby.map((n) => n.spot_id);
      const { rows } = await client.query(`${SPOT_SELECT} where s.id = any($1::uuid[])`, [ids]);

      const distanceById = new Map(
        nearby.map((n, i) => [
          n.spot_id,
          { meters: Number(n.distance_meters), minutes: n.walking_minutes, rank: i },
        ]),
      );

      const hydrated = rows
        .map((row) => mapSpotRow(row as never))
        .map((spot) => {
          const d = distanceById.get(spot.id);
          return { ...spot, distanceMeters: d?.meters, walkingMinutes: d?.minutes };
        })
        // Restore the function's ranking, which `= any(...)` does not preserve.
        .sort(
          (a, b) =>
            (distanceById.get(a.id)?.rank ?? 0) - (distanceById.get(b.id)?.rank ?? 0),
        );

      await attachTopQuotes(client, hydrated);
      return hydrated;
    });

    return NextResponse.json({ spots, count: spots.length });
  } catch (error) {
    return toErrorResponse(error);
  }
}
