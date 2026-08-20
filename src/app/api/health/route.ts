import { NextResponse } from "next/server";
import { isDatabaseConfigured, query } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

/**
 * Deployment diagnostics.
 *
 * Reports whether the database is reachable and seeded. Deliberately returns
 * only Postgres/Node *error codes* - never the message, host, or connection
 * string - because this endpoint is public and those fields leak
 * infrastructure detail. The codes are enough to tell the failures apart:
 *
 *   ENOTFOUND / EAI_AGAIN  hostname wrong or unresolvable
 *   ECONNREFUSED           reachable host, nothing listening
 *   ETIMEDOUT              blocked by network or SSL negotiation stalled
 *   28P01                  password authentication failed
 *   3D000                  database name does not exist
 *   42P01                  connected, but the schema was never applied
 */
export async function GET() {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ database: "unconfigured", hint: "DATABASE_URL is not set" });
  }

  try {
    // One round trip: three counts in a single row. `noUncheckedIndexedAccess`
    // is on, so the row is still guarded rather than indexed blindly.
    const rows = await query<{ stations: string; spots: string; postgis: string }>(
      `select (select count(*) from mbta_stations)::text          as stations,
              (select count(*) from spots where is_verified)::text as spots,
              postgis_version()                                    as postgis`,
    );

    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { database: "error", code: "NO_ROWS", routine: null },
        { status: 503 },
      );
    }

    return NextResponse.json({
      database: "connected",
      postgis: row.postgis,
      stations: Number(row.stations),
      verifiedSpots: Number(row.spots),
      ready: Number(row.stations) > 0,
    });
  } catch (error) {
    const e = error as { code?: string; routine?: string };
    return NextResponse.json(
      {
        database: "error",
        // Code only. The message can contain the host and user.
        code: e.code ?? "UNKNOWN",
        routine: e.routine ?? null,
      },
      { status: 503 },
    );
  }
}
