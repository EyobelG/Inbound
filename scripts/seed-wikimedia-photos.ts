/**
 * Backfills `spot_photos` from Wikimedia Commons.
 *
 * Google Places photos require a billed API key, so a fresh database renders
 * with empty cards until someone pays. Commons is keyless and openly licensed,
 * which makes it the right source for cold-start imagery - the same bootstrap
 * argument that governs seeded spots generally.
 *
 * The matching and writing live in `src/lib/wikimedia/photos.ts`, shared with
 * the token-guarded route that seeds the deployed database. This file is the
 * command line around them, plus the probes used to tune the rejection rules
 * without touching a database at all.
 *
 *   npm run seed:wikimedia -- --limit=900
 *   npm run seed:wikimedia -- --dry-run --limit=10
 *   npm run seed:wikimedia -- --name="Union Oyster House"
 *   npm run seed:wikimedia -- --names-file=venues.txt
 */
import { getPool } from "../src/lib/db/pool";
import {
  attachCommonsPhotos,
  findPhoto,
  type Candidate,
  type SpotRow,
} from "../src/lib/wikimedia/photos";

/** Probes run against a name alone, with no row and no trustworthy point. */
function probeSpot(name: string, lat: number, lng: number, precise: boolean): SpotRow {
  return { id: "probe", name, neighborhood: null, lat, lng, preciseLocation: precise };
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
      let candidate: Candidate | null = null;
      try {
        candidate = await findPhoto(probeSpot(name, 42.3601, -71.0589, false), radius, allowGeosearch);
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
  // rejection rules can be tuned before a single row is written.
  if (probeName) {
    const spot = probeSpot(
      probeName,
      Number(args.get("lat") ?? 42.3601),
      Number(args.get("lng") ?? -71.0589),
      args.has("lat") && args.has("lng"),
    );
    const candidate = await findPhoto(spot, radius, allowGeosearch);
    console.log(
      candidate ? JSON.stringify(candidate, null, 2) : `No usable photo for ${probeName}.`,
    );
    return;
  }

  const pool = getPool();

  // A dry run resolves candidates without writing, so it deliberately does not
  // go through attachCommonsPhotos - that function's whole job is the insert.
  if (dryRun) {
    const { rows: spots } = await pool.query<SpotRow>(
      `select s.id, s.name, s.neighborhood,
              st_y(s.location::geometry) as lat,
              st_x(s.location::geometry) as lng
         from spots s
        where not exists (select 1 from spot_photos p where p.spot_id = s.id)
        order by s.created_at
        limit $1`,
      [limit],
    );
    console.log(`${spots.length} spots without photos.`);

    let would = 0;
    for (const spot of spots) {
      const candidate = await findPhoto(
        { ...spot, lat: Number(spot.lat), lng: Number(spot.lng), preciseLocation: true },
        radius,
        allowGeosearch,
      ).catch(() => null);
      console.log(
        candidate
          ? `  +  ${spot.name}: ${candidate.fileTitle} (${candidate.license})`
          : `  -  ${spot.name}: no usable photo`,
      );
      if (candidate) would++;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    console.log(`Dry run: ${would}/${spots.length} spots would receive a photo.`);
    await pool.end();
    return;
  }

  const result = await attachCommonsPhotos(pool, {
    limit,
    radiusMeters: radius,
    allowGeosearch,
    onProgress: (line) => console.log(line),
  });

  console.log(
    `Attached ${result.attached} Commons photos ` +
      `(${result.examined} examined, ${result.remaining} spots still without one).`,
  );
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
