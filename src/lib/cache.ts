import { Redis } from "@upstash/redis";

/**
 * Cache is optional infrastructure: if Upstash is unconfigured or unreachable,
 * every helper degrades to a straight call through to the loader. A cache
 * outage must never take down search.
 */
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export const CACHE_TTL = {
  /** Station graph changes only when the MBTA reshapes the network. */
  stationGraph: 60 * 60 * 24,
  /** Midpoint results are a pure function of the graph. */
  midpoint: 60 * 60 * 12,
  /** Spot search reflects new reviews, so keep it short. */
  spotSearch: 60 * 5,
} as const;

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!redis) return loader();

  try {
    const hit = await redis.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch (error) {
    console.warn(`[cache] read failed for ${key}`, error);
    return loader();
  }

  const value = await loader();

  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    console.warn(`[cache] write failed for ${key}`, error);
  }

  return value;
}

export async function invalidate(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (error) {
    console.warn(`[cache] invalidate failed for ${key}`, error);
  }
}

/** Stable cache keys - build them here so no two call sites disagree. */
export const cacheKey = {
  stationGraph: () => "inbound:graph:v1",
  midpoint: (a: string, b: string) =>
    // Symmetric: midpoint(a,b) === midpoint(b,a), so sort before hashing.
    `inbound:midpoint:v1:${[a, b].sort().join(":")}`,
  spotSearch: (fingerprint: string) => `inbound:search:v1:${fingerprint}`,
};
