import type { Pool } from "pg";
import { parseOsmOpeningHours } from "@/lib/osm/hours";
import type { PriceTier, SpotCategory } from "@/types/domain";

/**
 * Seeds `spots` from OpenStreetMap via the Overpass API.
 *
 * Overpass needs no API key, no signup, and no billing, and it returns the
 * whole venue inventory inside a bounding box rather than only the places
 * somebody happened to post about - which makes it a better cold start than
 * scraping recommendations and resolving them against a paid geocoder.
 */
const OVERPASS = "https://overpass-api.de/api/interpreter";

/** Boston, Cambridge, Somerville, Brookline - the area the subway actually serves. */
const BBOX = { south: 42.30, west: -71.18, north: 42.42, east: -71.00 } as const;

/**
 * OSM tag -> our category. Anything unmapped is skipped rather than guessed:
 * a mis-categorised spot breaks the Step 1 / Step 2 split, which is the whole
 * product thesis.
 */
const AMENITY_CATEGORY: Record<string, SpotCategory> = {
  cafe: "cafe",
  bar: "bar",
  pub: "bar",
  biergarten: "bar",
  restaurant: "restaurant",
  ice_cream: "dessert",
  cinema: "activity",
};

const TOURISM_CATEGORY: Record<string, SpotCategory> = {
  museum: "activity",
  gallery: "activity",
  artwork: "activity",
};

const LEISURE_CATEGORY: Record<string, SpotCategory> = {
  park: "walk_park",
  garden: "walk_park",
  bowling_alley: "activity",
};

const SHOP_CATEGORY: Record<string, SpotCategory> = {
  bakery: "dessert",
  pastry: "dessert",
  confectionery: "dessert",
  coffee: "cafe",
};

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function categoryFor(tags: Record<string, string>): SpotCategory | null {
  return (
    (tags.amenity && AMENITY_CATEGORY[tags.amenity]) ||
    (tags.tourism && TOURISM_CATEGORY[tags.tourism]) ||
    (tags.leisure && LEISURE_CATEGORY[tags.leisure]) ||
    (tags.shop && SHOP_CATEGORY[tags.shop]) ||
    null
  );
}

/**
 * OSM has no price data. `price_tier` is NOT NULL, so seeded rows carry a
 * neutral placeholder rather than a fabricated guess - parks and cafes get the
 * cheap tier because that much is safe to assert, everything else defaults to
 * mid and is corrected by review.
 */
function priceFor(category: SpotCategory): PriceTier {
  return category === "walk_park" || category === "cafe" ? "$" : "$$";
}

function addressFor(tags: Record<string, string>): string {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Address not recorded in OpenStreetMap";
}

function slugify(name: string, id: number): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // OSM id keeps two venues with the same name from colliding on the unique slug.
  return `${base || "spot"}-${id}`;
}

export interface SeedSpotsResult {
  fetched: number;
  inserted: number;
  skippedNoCategory: number;
  byCategory: Record<string, number>;
}

export async function seedSpotsFromOsm(
  pool: Pool,
  limit = 900,
): Promise<SeedSpotsResult> {
  const query = `
    [out:json][timeout:60];
    (
      nwr["amenity"~"^(cafe|bar|pub|biergarten|restaurant|ice_cream|cinema)$"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["tourism"~"^(museum|gallery)$"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["leisure"~"^(park|garden|bowling_alley)$"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["shop"~"^(bakery|pastry|confectionery|coffee)$"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
    );
    out center ${limit};
  `;

  const response = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Overpass failed: ${response.status}`);

  const body = (await response.json()) as { elements: OverpassElement[] };

  const names: string[] = [];
  const slugs: string[] = [];
  const neighborhoods: string[] = [];
  const addresses: string[] = [];
  const lngs: number[] = [];
  const lats: number[] = [];
  const prices: string[] = [];
  const categories: string[] = [];
  const hours: string[] = [];

  const byCategory: Record<string, number> = {};
  let skippedNoCategory = 0;
  const seenSlugs = new Set<string>();

  for (const el of body.elements) {
    const tags = el.tags;
    if (!tags?.name) continue;

    const category = categoryFor(tags);
    if (!category) {
      skippedNoCategory++;
      continue;
    }

    // Ways and relations carry a computed centroid rather than a position.
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;

    const slug = slugify(tags.name, el.id);
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    names.push(tags.name);
    slugs.push(slug);
    // Real value when OSM knows it; the nearest-station trigger is what the
    // product actually navigates by, so this is presentational only.
    neighborhoods.push(tags["addr:suburb"] || tags["addr:city"] || "Boston");
    addresses.push(addressFor(tags));
    lngs.push(lon);
    lats.push(lat);
    prices.push(priceFor(category));
    categories.push(category);
    hours.push(JSON.stringify(parseOsmOpeningHours(tags.opening_hours)));

    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  if (names.length === 0) {
    return { fetched: body.elements.length, inserted: 0, skippedNoCategory, byCategory };
  }

  /**
   * Inserted as verified, unlike the Reddit + Places pipeline.
   *
   * That pipeline's rows stay unverified because an LLM- or regex-extracted
   * venue name is a guess that has to be checked. OSM rows involve no
   * extraction step: the name, coordinates, and category are structured fields
   * maintained by mappers, so there is nothing for a human to disambiguate.
   * `nearest_station_id` and `walking_minutes_to_t` are left to the
   * attach_nearest_station trigger.
   */
  const { rowCount } = await pool.query(
    `insert into spots
       (name, slug, neighborhood, address, location, price_tier, category,
        opening_hours, is_verified)
     select u.name, u.slug, u.neighborhood, u.address,
            st_setsrid(st_makepoint(u.lng, u.lat), 4326)::geography,
            u.price::price_tier, u.category::spot_category, u.hours::jsonb, true
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[],
                   $6::float8[], $7::text[], $8::text[], $9::text[])
         as u(name, slug, neighborhood, address, lng, lat, price, category, hours)
     on conflict (slug) do update set
       name          = excluded.name,
       address       = excluded.address,
       location      = excluded.location,
       opening_hours = excluded.opening_hours`,
    [names, slugs, neighborhoods, addresses, lngs, lats, prices, categories, hours],
  );

  return {
    fetched: body.elements.length,
    inserted: rowCount ?? names.length,
    skippedNoCategory,
    byCategory,
  };
}
