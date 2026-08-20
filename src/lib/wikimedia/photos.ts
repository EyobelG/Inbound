/**
 * Wikimedia Commons photo sourcing for spots.
 *
 * Lives in `src/lib` rather than inside the seeding script because two callers
 * need it and must not drift: the CLI seeder, and the token-guarded route that
 * runs inside the deployment. The Neon connection string is a Sensitive Vercel
 * variable - write-only, so it cannot be pulled locally to seed against - which
 * means populating a deployed database has to happen from inside the deployment
 * that already holds the credential.
 *
 * Relevance, not retrieval, is the hard part here; see `isArticleAboutThisPlace`.
 */
import type { Pool, PoolClient } from "pg";
import { haversineMeters } from "@/lib/geo";
import {
  THUMB_WIDTH_PX,
  MIN_WIDTH_PX,
  isPlausibleVenuePhoto,
  titleMatchesVenue,
} from "@/lib/wikimedia/match";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

/**
 * The Wikimedia API policy asks for a descriptive agent naming the application
 * so operators can identify traffic; anonymous bulk requests get throttled.
 */
const USER_AGENT =
  "InboundDateApp/0.1 (https://github.com/EyobelG/Inbound; transit-aware date planner)";

export interface Candidate {
  fileTitle: string;
  url: string;
  width: number;
  attribution: string;
  license: string;
  sourcePageUrl: string;
}

export interface SpotRow {
  id: string;
  name: string;
  neighborhood: string | null;
  lat: number;
  lng: number;
  /** False for `--name` probes, where lat/lng are only a city-centre stand-in. */
  preciseLocation: boolean;
}

/**
 * How far an article's own coordinates may sit from the spot before the match
 * is rejected. Generous enough to absorb the difference between an OSM door
 * node and Wikipedia's building centroid, tight enough that it cannot drift to
 * the business next door.
 */
const ARTICLE_MATCH_RADIUS_M = 500;

/** Greater Boston, used when the caller has no trustworthy point of its own. */
const BOUNDS = { west: -71.22, south: 42.29, east: -70.98, north: 42.42 };

/**
 * Is this article about *this place*, as opposed to a word that happens to
 * match it?
 *
 * Name matching alone cannot tell the difference, and the failures are not
 * subtle: "Harvest" resolves to Wikipedia's article on crop harvesting and
 * returns a photograph of a wheat field in Volgograd Oblast; "Starbucks" and
 * "Ben & Jerry's" resolve to the companies and return their Seattle
 * headquarters and Vermont factory. All three are about a subject, not a
 * location, and none of them carries coordinates - while every correct match
 * observed (Grendel's Den, Charlie's Kitchen, Yume Wo Katare) is geotagged
 * within metres of the venue.
 *
 * So coordinates are required, and they must land on the spot. The cost is a
 * genuine loss - Tatte Bakery's article has no coordinates and is dropped -
 * and that is the intended trade: an empty card beats a confident photograph
 * of somewhere else.
 */
function isArticleAboutThisPlace(
  spot: SpotRow,
  point: { lat: number; lon: number } | undefined,
): boolean {
  if (!point) return false;

  if (spot.preciseLocation) {
    return (
      haversineMeters(
        { lat: spot.lat, lng: spot.lng },
        { lat: point.lat, lng: point.lon },
      ) <= ARTICLE_MATCH_RADIUS_M
    );
  }

  return (
    point.lon >= BOUNDS.west && point.lon <= BOUNDS.east &&
    point.lat >= BOUNDS.south && point.lat <= BOUNDS.north
  );
}

async function callApi(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Wikimedia ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** extmetadata ships HTML fragments; cards render plain text. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads licence and authorship for a Commons file, or null if unattributable. */
async function fetchFileMetadata(fileTitle: string): Promise<Candidate | null> {
  const data = await callApi(COMMONS_API, {
    action: "query",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: String(THUMB_WIDTH_PX),
  });

  const query = data.query as { pages?: Record<string, unknown> } | undefined;
  const page = Object.values(query?.pages ?? {})[0] as
    | {
        title?: string;
        imageinfo?: Array<{
          thumburl?: string;
          url?: string;
          width?: number;
          thumbwidth?: number;
          descriptionurl?: string;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }
    | undefined;

  const info = page?.imageinfo?.[0];
  if (!info) return null;

  const meta = info.extmetadata ?? {};
  const artist = stripHtml(meta.Artist?.value ?? "");
  const license = stripHtml(
    meta.LicenseShortName?.value ?? meta.License?.value ?? "",
  );
  const sourcePageUrl = info.descriptionurl ?? "";

  // The schema rejects a wikimedia row missing any of these, so drop the
  // candidate here rather than letting the insert fail downstream.
  if (!artist || !license || !sourcePageUrl) return null;

  const width = info.thumbwidth ?? info.width ?? 0;
  if (width < MIN_WIDTH_PX) return null;

  return {
    fileTitle: page?.title ?? fileTitle,
    // Strip the analytics query string Commons appends to imageinfo URLs.
    url: (info.thumburl ?? info.url ?? "").split("?")[0]!,
    width,
    attribution: artist,
    license,
    sourcePageUrl,
  };
}

async function searchArticles(spot: SpotRow, query: string): Promise<Candidate | null> {
  const data = await callApi(WIKIPEDIA_API, {
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "3",
    prop: "pageimages|coordinates",
    piprop: "name",
  });

  const pages = Object.values(
    (data.query as { pages?: Record<string, unknown> } | undefined)?.pages ?? {},
  ) as Array<{
    title?: string;
    pageimage?: string;
    coordinates?: Array<{ lat: number; lon: number }>;
  }>;

  for (const page of pages) {
    if (!page.title || !page.pageimage) continue;
    if (!titleMatchesVenue(spot.name, page.title)) continue;
    if (!isArticleAboutThisPlace(spot, page.coordinates?.[0])) continue;

    const fileTitle = `File:${page.pageimage}`;
    if (!isPlausibleVenuePhoto(fileTitle)) continue;

    const candidate = await fetchFileMetadata(fileTitle);
    if (candidate) return candidate;
  }
  return null;
}

/** Strategy 1: the lead image of the venue's own Wikipedia article. */
async function findByArticle(spot: SpotRow): Promise<Candidate | null> {
  // The neighbourhood is deliberately NOT in the primary query. Once spots
  // carry a real address, appending it buries the venue name in locality terms
  // - "Union Oyster House Government Center/Faneuil Hall Boston" ranks the
  // neighbourhood's own article above the restaurant's. It is a fallback for
  // ambiguous names, never the first thing asked.
  const queries = [`${spot.name} Boston`];
  if (spot.neighborhood && spot.neighborhood !== "Unassigned") {
    queries.push(`${spot.name} ${spot.neighborhood}`);
  }

  for (const query of queries) {
    const found = await searchArticles(spot, query);
    if (found) return found;
  }
  return null;
}

/**
 * Strategy 2: geotagged Commons files near the spot. Deliberately a narrow
 * radius - widening it does not find better photos of this venue, it finds
 * photos of the neighbours.
 */
async function findByGeography(spot: SpotRow, radiusMeters: number): Promise<Candidate | null> {
  const data = await callApi(COMMONS_API, {
    action: "query",
    generator: "geosearch",
    ggscoord: `${spot.lat}|${spot.lng}`,
    ggsradius: String(radiusMeters),
    ggslimit: "20",
    ggsnamespace: "6",
    prop: "imageinfo",
    iiprop: "url",
  });

  const pages = Object.values(
    (data.query as { pages?: Record<string, unknown> } | undefined)?.pages ?? {},
  ) as Array<{ title?: string }>;

  for (const page of pages) {
    if (!page.title || !isPlausibleVenuePhoto(page.title)) continue;
    const candidate = await fetchFileMetadata(page.title);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Geography is opt-in, and off by default on purpose. Proximity is evidence
 * about a location, not about a business: the nearest geotagged file to a
 * bookshop was a screenshot of an unrelated software project, and dense blocks
 * return Mapillary frames. An empty card is recoverable, a confidently wrong
 * photo of someone else's storefront is not.
 */
export async function findPhoto(
  spot: SpotRow,
  radiusMeters: number,
  allowGeosearch: boolean,
): Promise<Candidate | null> {
  const byArticle = await findByArticle(spot);
  if (byArticle || !allowGeosearch) return byArticle;
  return findByGeography(spot, radiusMeters);
}

export interface SeedOptions {
  limit?: number;
  radiusMeters?: number;
  allowGeosearch?: boolean;
  /**
   * Wall-clock budget. A serverless invocation is capped, and a partial batch
   * that reports its progress is far more useful than one killed mid-flight:
   * the next run simply picks up the spots that still have no photo.
   */
  budgetMs?: number;
  onProgress?: (line: string) => void;
}

export interface SeedResult {
  examined: number;
  attached: number;
  remaining: number;
  timedOut: boolean;
}

/** Spots with no photo of any source, oldest first so runs are deterministic. */
const PENDING_SPOTS = `
  select s.id,
         s.name,
         s.neighborhood,
         st_y(s.location::geometry) as lat,
         st_x(s.location::geometry) as lng
    from spots s
   where not exists (select 1 from spot_photos p where p.spot_id = s.id)
   order by s.created_at
   limit $1
`;

const REMAINING_SPOTS = `
  select count(*)::text as n
    from spots s
   where not exists (select 1 from spot_photos p where p.spot_id = s.id)
`;

/**
 * Attaches one Commons photo to each spot that currently has none.
 *
 * Idempotent by construction: it only ever considers spots with no photo, and
 * the insert upserts on (spot_id, url). Re-running is safe and stopping early
 * costs nothing, which is what makes it viable to drive from a capped
 * serverless invocation a batch at a time.
 */
export async function attachCommonsPhotos(
  db: Pool | PoolClient,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const {
    limit = 25,
    radiusMeters = 120,
    allowGeosearch = false,
    budgetMs = Number.POSITIVE_INFINITY,
    onProgress,
  } = options;

  const startedAt = Date.now();
  const { rows: spots } = await db.query<SpotRow>(PENDING_SPOTS, [limit]);

  let attached = 0;
  let examined = 0;
  let timedOut = false;

  for (const spot of spots) {
    if (Date.now() - startedAt > budgetMs) {
      timedOut = true;
      break;
    }
    examined++;

    let candidate: Candidate | null = null;
    try {
      candidate = await findPhoto(
        {
          ...spot,
          lat: Number(spot.lat),
          lng: Number(spot.lng),
          preciseLocation: true,
        },
        radiusMeters,
        allowGeosearch,
      );
    } catch (error) {
      onProgress?.(`  !  ${spot.name}: ${(error as Error).message}`);
      continue;
    }

    if (!candidate) {
      onProgress?.(`  -  ${spot.name}: no usable photo`);
      continue;
    }

    await db.query(
      `insert into spot_photos
         (spot_id, url, caption, source, display_order,
          attribution, license, source_page_url)
       values ($1, $2, $3, 'wikimedia', 0, $4, $5, $6)
       on conflict (spot_id, url) do update set
         caption         = excluded.caption,
         attribution     = excluded.attribution,
         license         = excluded.license,
         source_page_url = excluded.source_page_url`,
      [
        spot.id,
        candidate.url,
        candidate.fileTitle.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
        candidate.attribution,
        candidate.license,
        candidate.sourcePageUrl,
      ],
    );
    attached++;
    onProgress?.(`  +  ${spot.name}: ${candidate.fileTitle} (${candidate.license})`);

    // Wikimedia asks unauthenticated clients to stay serial and unhurried.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const { rows } = await db.query<{ n: string }>(REMAINING_SPOTS);
  return { examined, attached, remaining: Number(rows[0]!.n), timedOut };
}
