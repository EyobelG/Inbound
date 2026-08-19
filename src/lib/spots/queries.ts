import type { PoolClient } from "pg";
import { parsePoint } from "@/lib/geo";
import type { DateStage, Spot } from "@/types/domain";

/**
 * Spot hydration in one round trip.
 *
 * Vibes and photos are folded in as correlated subqueries rather than joined:
 * a join against spot_photos multiplies the spot row per photo, and
 * deduplicating that in application code is both slower and easier to get
 * wrong than letting Postgres build the JSON.
 */
const SPOT_SELECT = `
  select
    s.id, s.name, s.slug, s.neighborhood, s.address,
    st_asgeojson(s.location)::json as location,
    s.price_tier, s.category, s.nearest_station_id, s.walking_minutes_to_t,
    s.google_place_id, s.opening_hours, s.is_verified,
    (
      select row_to_json(v)
        from (
          select avg_noise_level, lighting_score, easy_exit_score,
                 best_for_stage, total_reviews_count
            from spot_vibes where spot_id = s.id
        ) v
    ) as vibes,
    coalesce((
      select json_agg(p order by p.display_order)
        from (
          select id, url, caption, source, display_order
            from spot_photos where spot_id = s.id
        ) p
    ), '[]'::json) as photos
  from spots s
`;

const EMPTY_STAGE_VOTES: Record<DateStage, number> = {
  first_date: 0,
  second_or_third: 0,
  established_exclusive: 0,
  anniversary: 0,
};

interface RawSpotRow {
  id: string;
  name: string;
  slug: string;
  neighborhood: string;
  address: string;
  location: unknown;
  price_tier: Spot["priceTier"];
  category: Spot["category"];
  nearest_station_id: string | null;
  walking_minutes_to_t: number | null;
  google_place_id: string | null;
  opening_hours: unknown;
  is_verified: boolean;
  vibes: null | {
    avg_noise_level: string | number | null;
    lighting_score: string | number | null;
    easy_exit_score: string | number | null;
    best_for_stage: Record<string, number> | null;
    total_reviews_count: number;
  };
  photos: Array<{
    id: string;
    url: string;
    caption: string | null;
    source: "google_places" | "community_upload";
    display_order: number;
  }>;
}

/** node-postgres returns numeric as string to avoid float64 precision loss. */
function num(value: string | number | null): number | null {
  return value == null ? null : Number(value);
}

export function mapSpotRow(row: RawSpotRow): Spot {
  const vibes = row.vibes;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    neighborhood: row.neighborhood,
    address: row.address,
    location: parsePoint(row.location),
    priceTier: row.price_tier,
    category: row.category,
    nearestStationId: row.nearest_station_id,
    walkingMinutesToT: row.walking_minutes_to_t,
    googlePlaceId: row.google_place_id,
    openingHours: Array.isArray(row.opening_hours) ? row.opening_hours : [],
    isVerified: row.is_verified,
    vibes: vibes
      ? {
          avgNoiseLevel: num(vibes.avg_noise_level),
          lightingScore: num(vibes.lighting_score),
          easyExitScore: num(vibes.easy_exit_score),
          bestForStage: { ...EMPTY_STAGE_VOTES, ...(vibes.best_for_stage ?? {}) },
          totalReviewsCount: vibes.total_reviews_count,
        }
      : null,
    photos: (row.photos ?? []).map((p) => ({
      id: p.id,
      url: p.url,
      caption: p.caption,
      source: p.source,
      displayOrder: p.display_order,
    })),
    topQuote: null,
  };
}

export async function fetchSpotsByIds(client: PoolClient, ids: string[]): Promise<Spot[]> {
  if (ids.length === 0) return [];

  const { rows } = await client.query<RawSpotRow>(`${SPOT_SELECT} where s.id = any($1::uuid[])`, [ids]);
  const spots = rows.map(mapSpotRow);
  await attachTopQuotes(client, spots);
  return spots;
}

/**
 * One batched query for the whole page of cards rather than a per-card fetch.
 * DISTINCT ON picks the single most-helpful review per spot inside Postgres,
 * so only the rows actually rendered cross the wire.
 */
export async function attachTopQuotes(client: PoolClient, spots: Spot[]): Promise<void> {
  if (spots.length === 0) return;

  try {
    const { rows } = await client.query<{
      spot_id: string;
      body_text: string;
      helpful_count: number;
      date_stage: DateStage;
    }>(
      `select distinct on (spot_id) spot_id, body_text, helpful_count, date_stage
         from user_reviews
        where spot_id = any($1::uuid[]) and body_text is not null
        order by spot_id, helpful_count desc`,
      [spots.map((s) => s.id)],
    );

    const best = new Map(rows.map((r) => [r.spot_id, r]));
    for (const spot of spots) {
      const row = best.get(spot.id);
      spot.topQuote = row
        ? { body: row.body_text, helpfulCount: row.helpful_count, dateStage: row.date_stage }
        : null;
    }
  } catch (error) {
    // A missing quote degrades the card, it doesn't break the page.
    console.warn("[spots] failed to load review quotes", (error as Error).message);
  }
}

/**
 * Verified-spot counts per station, used to rank midpoint candidates.
 *
 * A single set-returning query over all candidate stations, rather than one
 * round trip each: the midpoint shortlist is 25 stations, so the per-query
 * latency dominated everything else in the previous shape.
 */
export async function countSpotsNearStations(
  client: PoolClient,
  stationIds: string[],
  radiusMeters: number,
): Promise<Map<string, number>> {
  if (stationIds.length === 0) return new Map();

  const { rows } = await client.query<{ station_id: string; count: string }>(
    `select st.id as station_id, count(s.id) as count
       from mbta_stations st
       left join spots s
         on s.is_verified
        and st_dwithin(s.location, st.location, $2)
      where st.id = any($1::uuid[])
      group by st.id`,
    [stationIds, radiusMeters],
  );

  return new Map(rows.map((r) => [r.station_id, Number(r.count)]));
}

export { SPOT_SELECT };
