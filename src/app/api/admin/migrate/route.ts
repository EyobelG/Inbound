import { readFile } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-shot schema application for a managed database.
 *
 * Exists because the connection string lives in Vercel as a Sensitive
 * variable: it is write-only, so it cannot be pulled locally to run psql
 * against. Rather than move a production credential out of the platform, the
 * migration runs inside the deployment that already holds it.
 *
 * This is privileged - it executes DDL - so it is gated on a shared secret and
 * should be removed, or its token rotated, once the schema is settled.
 */
const SCHEMA_FILES = [
  "0001_schema.sql",
  "0002_functions.sql",
  "0003_rls.sql",
] as const;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.ADMIN_MIGRATE_TOKEN;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first - and
  // still run the comparison so the check does not leak length via timing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const applied: Array<{ file: string; status: string }> = [];

  for (const file of SCHEMA_FILES) {
    const full = path.join(process.cwd(), "firebase", "schema", file);
    try {
      const sql = await readFile(full, "utf8");
      // Simple query protocol: multiple statements and dollar-quoted function
      // bodies both execute correctly as long as no bind parameters are used.
      await pool.query(sql);
      applied.push({ file, status: "ok" });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      applied.push({ file, status: `failed: ${e.code ?? ""} ${e.message ?? ""}`.trim() });
      return NextResponse.json({ applied }, { status: 500 });
    }
  }

  const { rows } = await pool.query<{ tables: string; postgis: string }>(
    `select (select count(*) from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE')::text as tables,
            postgis_version() as postgis`,
  );

  return NextResponse.json({ applied, ...(rows[0] ?? {}) });
}
