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
    const [{ n: stations }] = await query<{ n: string }>(
      "select count(*)::text as n from mbta_stations",
    );
    const [{ n: spots }] = await query<{ n: string }>(
      "select count(*)::text as n from spots where is_verified",
    );
    const [{ postgis }] = await query<{ postgis: string }>(
      "select postgis_version() as postgis",
    );

    return NextResponse.json({
      database: "connected",
      postgis,
      stations: Number(stations),
      verifiedSpots: Number(spots),
      ready: Number(stations) > 0,
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
