/**
 * Seeds mbta_stations + mbta_transfers from the MBTA V3 API.
 *
 * The logic lives in src/lib/mbta/seedStations.ts so this script and the admin
 * endpoint cannot drift - the endpoint exists because a managed database's
 * connection string is write-only and unusable from a local script.
 *
 *   npm run seed:stations
 */
import { getPool } from "../src/lib/db/pool";
import { seedStations } from "../src/lib/mbta/seedStations";

async function main() {
  const pool = getPool();
  const result = await seedStations(pool);

  for (const [route, count] of Object.entries(result.perLine)) {
    console.log(`${route}: ${count} stops`);
  }
  console.log(`Upserted ${result.platforms} station platforms.`);
  console.log(`Upserted ${result.transfers} transfer edges.`);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
