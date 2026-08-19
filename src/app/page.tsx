import { isDatabaseConfigured, query } from "@/lib/db/pool";
import { parsePoint } from "@/lib/geo";
import { PlannerShell } from "@/components/PlannerShell";
import type { MbtaLine, Station } from "@/types/domain";

/**
 * Stations are loaded server-side and handed to the client shell as props: the
 * list is small, never user-specific, and needed before the first interaction,
 * so fetching it in the browser would only add a spinner.
 *
 * Public reference data, so this reads outside any per-user transaction - no
 * row here is hidden by RLS.
 */
async function loadStations(): Promise<Station[]> {
  // Boot with no credentials at all rather than 500-ing: a fresh clone should
  // render its own setup instructions, not a stack trace.
  if (!isDatabaseConfigured()) return [];

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await query(
      `select id, gtfs_stop_id, stop_name, line, branch, order_index,
              is_accessible, st_asgeojson(location)::json as location
         from mbta_stations
        order by line, order_index`,
    );
  } catch (error) {
    console.error("[page] failed to load stations", (error as Error).message);
    return [];
  }

  return rows.map((row) => ({
    id: row.id as string,
    gtfsStopId: row.gtfs_stop_id as string,
    stopName: row.stop_name as string,
    line: row.line as MbtaLine,
    branch: (row.branch as string | null) ?? null,
    orderIndex: row.order_index as number,
    isAccessible: row.is_accessible as boolean,
    location: parsePoint(row.location),
  }));
}

export default async function HomePage() {
  const stations = await loadStations();

  return (
    <main className="mx-auto max-w-7xl p-4">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Inbound</h1>
        <p className="text-sm text-muted-foreground">
          Two stops, one fair meeting point, no arguing about who travels further.
        </p>
      </header>

      {stations.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No stations loaded yet.</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Copy <code className="font-mono text-xs">.env.example</code> to{" "}
              <code className="font-mono text-xs">.env.local</code> and fill in your
              Cloud SQL, Firebase, and Mapbox keys.
            </li>
            <li>
              Apply the schema: <code className="font-mono text-xs">npm run db:migrate</code>
            </li>
            <li>
              Seed the station graph:{" "}
              <code className="font-mono text-xs">npm run seed:stations</code>
            </li>
          </ol>
        </div>
      ) : (
        <PlannerShell stations={stations} />
      )}
    </main>
  );
}
