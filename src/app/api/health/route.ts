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
    // Distinguish "the key was never added" from "the key exists but its value
    // is blank" - they look identical from the dashboard but need different
    // fixes. Only presence and length are reported, never any content.
    // Report which candidate names exist and whether they are blank - never any
    // content. A key added without a value looks identical to a correct one in
    // the dashboard but behaves like an unset variable at runtime.
    const candidates = ["DATABASE_URL", "POSTGRES_URL"];
    const seen = Object.fromEntries(
      candidates.map((name) => [
        name,
        name in process.env ? `present, length ${(process.env[name] ?? "").length}` : "absent",
      ]),
    );
    // Surface near-miss names (e.g. a marketplace integration configured with a
    // custom prefix) so a rename is obvious instead of invisible.
    const nearMisses = Object.keys(process.env).filter(
      (k) => k !== "DATABASE_URL" && k !== "POSTGRES_URL" && /DATABASE_URL$|POSTGRES_URL$/.test(k),
    );

    return NextResponse.json({
      database: "unconfigured",
      checked: seen,
      nearMisses,
      hint:
        nearMisses.length > 0
          ? `Found ${nearMisses[0]} - the integration was given a custom prefix. Clear the prefix so it injects DATABASE_URL or POSTGRES_URL.`
          : "No connection string is reaching this deployment.",
    });
  }

  try {
    // One round trip: every diagnostic in a single row. `noUncheckedIndexedAccess`
    // is on, so the row is still guarded rather than indexed blindly.
    const rows = await query<{
      stations: string;
      spots: string;
      postgis: string;
      bypasses_rls: boolean | null;
      owned_tables: string;
    }>(
      `select (select count(*) from mbta_stations)::text          as stations,
              (select count(*) from spots where is_verified)::text as spots,
              postgis_version()                                    as postgis,
              (select rolbypassrls from pg_roles
                where rolname = current_user)                      as bypasses_rls,
              (select count(*) from pg_tables
                where schemaname = 'public'
                  and tableowner = current_user)::text             as owned_tables`,
    );

    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { database: "error", code: "NO_ROWS", routine: null },
        { status: 503 },
      );
    }

    // RLS binds only if BOTH are true: the role does not carry BYPASSRLS, and
    // it owns none of the tables - policies never apply to a table's owner. The
    // Neon deploy failed on both counts at once, and either alone is enough to
    // silently disable all 22 policies with no other visible symptom.
    //
    // Reported as a boolean rather than `current_user` on purpose: this
    // endpoint is public, and the role name is infrastructure detail this file
    // otherwise refuses to emit. The boolean answers the operational question
    // - is the runtime role safe? - without naming the account.
    const rlsEnforced = row.bypasses_rls === false && Number(row.owned_tables) === 0;

    return NextResponse.json({
      database: "connected",
      postgis: row.postgis,
      stations: Number(row.stations),
      verifiedSpots: Number(row.spots),
      ready: Number(row.stations) > 0,
      rlsEnforced,
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
