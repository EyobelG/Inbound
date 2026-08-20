/**
 * Seeds `spots` from OpenStreetMap. No API key required.
 *
 * Shares its implementation with the admin endpoint (src/lib/osm/seedSpots.ts)
 * so a local run and a production run cannot diverge.
 *
 *   npm run seed:osm
 */
import { getPool } from "../src/lib/db/pool";
import { seedSpotsFromOsm } from "../src/lib/osm/seedSpots";

async function main() {
  const pool = getPool();
  const result = await seedSpotsFromOsm(pool);
  console.log(`Fetched ${result.fetched} OSM elements`);
  console.log(`Inserted/updated ${result.inserted} spots`);
  console.log(`Skipped ${result.skippedNoCategory} with no mappable category`);
  console.log("By category:", result.byCategory);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
