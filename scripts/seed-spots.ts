/**
 * Cold-start seeding: Reddit recommendations -> Google Places -> `spots`.
 *
 * The bootstrap problem is that vibe metrics need reviews and reviews need
 * inventory. This pipeline borrows inventory from where Bostonians already
 * argue about it (r/boston, r/cambridgeMA), then resolves each mention to a
 * real Google place so the row carries a verified address, hours, and photos.
 *
 * Every seeded spot lands with `is_verified = false`. Human review flips that
 * flag - an LLM-extracted venue name is a lead, not a fact, and unverified rows
 * are invisible to search by design (see the `spots_verified_idx` predicate).
 *
 *   npm run seed:spots -- --subreddit=boston --limit=100
 */
import { getPool } from "../src/lib/db/pool";
import type { OpeningWindow, PriceTier, SpotCategory } from "../src/types/domain";

interface RedditComment {
  body: string;
  score: number;
  permalink: string;
}

interface VenueMention {
  name: string;
  /** Upvotes on the comment that recommended it - the cold-start prior. */
  score: number;
  sourceUrl: string;
  context: string;
}

/** Boston/Cambridge/Somerville only: everything else is out of scope. */
const BOUNDS = { west: -71.22, south: 42.29, east: -70.98, north: 42.42 };

const GOOGLE_TYPE_TO_CATEGORY: Record<string, SpotCategory> = {
  bar: "bar",
  night_club: "bar",
  cafe: "cafe",
  coffee_shop: "cafe",
  restaurant: "restaurant",
  bakery: "dessert",
  ice_cream_shop: "dessert",
  dessert_shop: "dessert",
  park: "walk_park",
  tourist_attraction: "activity",
  bowling_alley: "activity",
  movie_theater: "activity",
  art_gallery: "activity",
  museum: "activity",
};

const PRICE_LEVEL_TO_TIER: Record<string, PriceTier> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

/**
 * Step 1 - harvest.
 *
 * Reddit's public JSON endpoint needs no auth for reads. Search date-recommendation
 * threads rather than the whole subreddit: a comment in r/boston about parking
 * is noise no extraction step can rescue.
 */
async function harvestMentions(subreddit: string, limit: number): Promise<VenueMention[]> {
  const query = encodeURIComponent('("date spot" OR "date night" OR "first date")');
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&restrict_sr=1&sort=top&t=year&limit=${limit}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "inbound-seeder/0.1 (contact: ops@inbound.app)" },
  });
  if (!response.ok) throw new Error(`Reddit search failed: ${response.status}`);

  const body = (await response.json()) as {
    data: { children: Array<{ data: RedditComment & { selftext?: string; title: string } }> };
  };

  const mentions: VenueMention[] = [];
  for (const child of body.data.children) {
    const post = child.data;
    const text = `${post.title}\n${post.selftext ?? ""}`;
    // Extraction is deliberately a separate, swappable step: a proper-noun
    // regex is the cheap baseline, an LLM pass is the accurate one. Both feed
    // the same resolver below.
    for (const name of extractVenueNames(text)) {
      mentions.push({
        name,
        score: post.score,
        sourceUrl: `https://reddit.com${post.permalink}`,
        context: text.slice(0, 400),
      });
    }
  }

  // Consensus dedupe: the same bar named in five threads outranks a one-off.
  const byName = new Map<string, VenueMention>();
  for (const mention of mentions) {
    const key = mention.name.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.score += mention.score;
    else byName.set(key, { ...mention });
  }

  return [...byName.values()].sort((a, b) => b.score - a.score);
}

/**
 * Baseline extractor: capitalized multi-word phrases that aren't sentence
 * openers. Swap for an LLM call with a strict JSON schema when precision
 * matters more than cost - the interface is just string -> string[].
 */
function extractVenueNames(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-zA-Z'&.]+(?:\s+[A-Z][a-zA-Z'&.]+){0,3})\b/g) ?? [];
  const stopwords = new Set(["I", "The", "Boston", "Cambridge", "Somerville", "Red Line", "T"]);
  return [...new Set(matches)].filter((m) => m.length > 3 && !stopwords.has(m));
}

/**
 * Step 2 - resolve. Google Places Text Search, biased to our bounding box, is
 * what turns "that wine bar in Union Sq" into a place_id with real coordinates.
 * A mention that doesn't resolve inside the box is dropped, not guessed.
 */
async function resolvePlace(mention: VenueMention) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is required to resolve venues.");

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.priceLevel",
        "places.types",
        "places.regularOpeningHours",
        "places.photos",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: `${mention.name} Boston MA`,
      locationRestriction: {
        rectangle: {
          low: { latitude: BOUNDS.south, longitude: BOUNDS.west },
          high: { latitude: BOUNDS.north, longitude: BOUNDS.east },
        },
      },
      maxResultCount: 1,
    }),
  });

  if (!response.ok) {
    console.warn(`[places] ${mention.name}: ${response.status}`);
    return null;
  }

  const body = (await response.json()) as { places?: GooglePlace[] };
  return body.places?.[0] ?? null;
}

interface GooglePlace {
  id: string;
  displayName: { text: string };
  formattedAddress: string;
  location: { latitude: number; longitude: number };
  priceLevel?: string;
  types: string[];
  regularOpeningHours?: {
    periods: Array<{
      open: { day: number; hour: number; minute: number };
      close?: { day: number; hour: number; minute: number };
    }>;
  };
  photos?: Array<{ name: string }>;
}

function toOpeningWindows(place: GooglePlace): OpeningWindow[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (place.regularOpeningHours?.periods ?? [])
    .filter((p) => p.close)
    .map((p) => ({
      day: p.open.day,
      open: `${pad(p.open.hour)}:${pad(p.open.minute)}`,
      close: `${pad(p.close!.hour)}:${pad(p.close!.minute)}`,
    }));
}

function toCategory(place: GooglePlace): SpotCategory | null {
  for (const type of place.types) {
    const category = GOOGLE_TYPE_TO_CATEGORY[type];
    if (category) return category;
  }
  return null; // unmappable type: skip rather than guess
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]),
  );
  const subreddit = args.get("subreddit") ?? "boston";
  const limit = Number(args.get("limit") ?? 50);

  const pool = getPool();
  const mentions = await harvestMentions(subreddit, limit);
  console.log(`Harvested ${mentions.length} candidate venues from r/${subreddit}.`);

  let inserted = 0;
  for (const mention of mentions) {
    const place = await resolvePlace(mention);
    if (!place) continue;

    const category = toCategory(place);
    if (!category) continue;

    // `nearest_station_id` and `walking_minutes_to_t` are left unset on
    // purpose: the `spots_attach_nearest_station` trigger computes both from
    // the geometry, so the seeder can never disagree with the database.
    let spotId: string;
    try {
      const { rows } = await pool.query<{ id: string }>(
        `insert into spots
           (name, slug, neighborhood, address, location, price_tier, category,
            google_place_id, opening_hours, is_verified)
         values ($1, $2, $3, $4,
                 st_setsrid(st_makepoint($5, $6), 4326)::geography,
                 $7::price_tier, $8::spot_category, $9, $10::jsonb, false)
         on conflict (google_place_id) do update set
           name          = excluded.name,
           address       = excluded.address,
           location      = excluded.location,
           price_tier    = excluded.price_tier,
           opening_hours = excluded.opening_hours
         returning id`,
        [
          place.displayName.text,
          slugify(place.displayName.text),
          "Unassigned", // backfilled by a neighborhood polygon join
          place.formattedAddress,
          place.location.longitude,
          place.location.latitude,
          PRICE_LEVEL_TO_TIER[place.priceLevel ?? ""] ?? "$$",
          category,
          place.id,
          JSON.stringify(toOpeningWindows(place)),
        ],
      );
      spotId = rows[0]!.id;
    } catch (error) {
      console.warn(`[spots] ${place.displayName.text}: ${(error as Error).message}`);
      continue;
    }
    inserted++;

    // Places photo resources are fetched through our own proxy route so the
    // API key never reaches the browser.
    if (place.photos?.length) {
      const photos = place.photos.slice(0, 5);
      // Replace rather than append: re-running the seeder must not accumulate
      // duplicate photo rows for the same venue.
      await pool.query(
        `delete from spot_photos where spot_id = $1 and source = 'google_places'`,
        [spotId],
      );
      await pool.query(
        `insert into spot_photos (spot_id, url, source, display_order)
         select $1, u.url, 'google_places', u.display_order
           from unnest($2::text[], $3::int[]) as u(url, display_order)`,
        [
          spotId,
          photos.map((photo) => `/api/photos/${photo.name}`),
          photos.map((_, i) => i),
        ],
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  console.log(`Seeded ${inserted} unverified spots. Review them before flipping is_verified.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
