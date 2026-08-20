/**
 * Backfills `spot_photos` from Wikimedia Commons.
 *
 * Google Places photos require a billed API key, so a fresh database renders
 * with empty cards until someone pays. Commons is keyless and openly licensed,
 * which makes it the right source for cold-start imagery - the same bootstrap
 * argument that governs seeded spots generally.
 *
 * Relevance is the whole problem here, not retrieval. A naive geosearch around
 * a downtown cafe returns Mapillary street-camera frames - thousands of blurry
 * drive-by stills are geotagged across Boston, and they outnumber real venue
 * photography. So candidates are matched by article first, geography second,
 * and every candidate runs a rejection gauntlet before it is allowed to stand
 * in for a date spot.
 *
 * Attribution is not optional: CC-BY / CC-BY-SA require the author, the licence
 * and a link to the file page, and `spot_photos_source_provenance` (0004)
 * rejects a wikimedia row missing any of the three. A candidate whose metadata
 * cannot be read is dropped rather than inserted bare.
 *
 *   npm run seed:wikimedia -- --limit=50
 *   npm run seed:wikimedia -- --dry-run --limit=10
 *   npm run seed:wikimedia -- --dry-run --name="Union Oyster House"
 *   npm run seed:wikimedia -- --names-file=venues.txt
 */
import { getPool } from "../src/lib/db/pool";
import { haversineMeters } from "../src/lib/geo";
import {
  THUMB_WIDTH_PX,
  MIN_WIDTH_PX,
  isPlausibleVenuePhoto,
  titleMatchesVenue,
} from "../src/lib/wikimedia/match";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

/**
 * The Wikimedia API policy asks for a descriptive agent naming the application
 * so operators can identify traffic; anonymous bulk requests get throttled.
 */
const USER_AGENT =
  "InboundDateApp/0.1 (https://github.com/EyobelG/locality; transit-aware date planner)";

interface Candidate {
  fileTitle: string;
  url: string;
  width: number;
  attribution: string;
  license: string;
  sourcePageUrl: string;
}

interface SpotRow {
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

/**
 * Guards against Wikipedia's search happily returning a tangentially related
 * article: "Trident Booksellers" resolves to "List of booksellers in Boston",
 * whose lead image describes a different venue entirely. Requiring the
 * distinctive words of the venue name to appear in the article title keeps a
 * near-miss from being presented to a user as this spot's photo.
 */
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

  // Public-domain files legitimately have no author; everything else must.
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
async function findPhoto(
  spot: SpotRow,
  radiusMeters: number,
  allowGeosearch: boolean,
): Promise<Candidate | null> {
  const byArticle = await findByArticle(spot);
  if (byArticle || !allowGeosearch) return byArticle;
  return findByGeography(spot, radiusMeters);
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]),
  );
  const dryRun = args.has("dry-run");
  const limit = Number(args.get("limit") ?? 25);
  const radius = Number(args.get("radius") ?? 120);
  const probeName = args.get("name");
  const allowGeosearch = args.has("allow-geosearch");

  // `--names-file` probes a whole shortlist without touching the database, so a
  // curated venue list can be checked for coverage before anyone runs a seed.
  // One venue per line; blank lines and `#` comments are skipped.
  const namesFile = args.get("names-file");
  if (namesFile) {
    const { readFileSync } = await import("node:fs");
    const names = readFileSync(namesFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    let matched = 0;
    for (const name of names) {
      const spot: SpotRow = {
        id: "probe", name, neighborhood: null,
        lat: 42.3601, lng: -71.0589, preciseLocation: false,
      };
      let candidate: Candidate | null = null;
      try {
        candidate = await findPhoto(spot, radius, allowGeosearch);
      } catch (error) {
        console.warn(`[wikimedia] ${name}: ${(error as Error).message}`);
      }
      if (candidate) matched++;
      console.log(JSON.stringify({ venue: name, ...(candidate ?? { miss: true }) }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    console.error(`${matched}/${names.length} matched.`);
    return;
  }

  // `--name` probes the matcher without touching the database, which is how the
  // rejection rules above can be tuned before a single row is written.
  if (probeName) {
    const spot: SpotRow = {
      id: "probe",
      name: probeName,
      neighborhood: null,
      lat: Number(args.get("lat") ?? 42.3601),
      lng: Number(args.get("lng") ?? -71.0589),
      preciseLocation: args.has("lat") && args.has("lng"),
    };
    const candidate = await findPhoto(spot, radius, allowGeosearch);
    console.log(candidate ? JSON.stringify(candidate, null, 2) : `No usable photo for ${probeName}.`);
    return;
  }

  const pool = getPool();
  const { rows: spots } = await pool.query<SpotRow>(
    `select s.id,
            s.name,
            s.neighborhood,
            st_y(s.location::geometry) as lat,
            st_x(s.location::geometry) as lng
       from spots s
      where not exists (
              select 1 from spot_photos p where p.spot_id = s.id
            )
      order by s.created_at
      limit $1`,
    [limit],
  );
  console.log(`${spots.length} spots without photos.`);

  let attached = 0;
  for (const spot of spots) {
    let candidate: Candidate | null = null;
    try {
      candidate = await findPhoto(
        {
          ...spot,
          lat: Number(spot.lat),
          lng: Number(spot.lng),
          preciseLocation: true,
        },
        radius,
        allowGeosearch,
      );
    } catch (error) {
      console.warn(`[wikimedia] ${spot.name}: ${(error as Error).message}`);
    }

    if (!candidate) {
      console.log(`  - ${spot.name}: no usable photo`);
    } else if (dryRun) {
      console.log(`  + ${spot.name}: ${candidate.fileTitle} (${candidate.license})`);
      attached++;
    } else {
      await pool.query(
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
      console.log(`  + ${spot.name}: ${candidate.fileTitle} (${candidate.license})`);
      attached++;
    }

    // Wikimedia asks unauthenticated clients to stay serial and unhurried.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(
    dryRun
      ? `Dry run: ${attached}/${spots.length} spots would receive a photo.`
      : `Attached ${attached} Commons photos.`,
  );
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
