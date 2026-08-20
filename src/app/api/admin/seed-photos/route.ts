import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { NextResponse, type NextRequest } from "next/server";
import { resolveConnectionString } from "@/lib/db/pool";
import { attachCommonsPhotos } from "@/lib/wikimedia/photos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Batch-attaches Wikimedia Commons photos to spots that have none.
 *
 * Exists for the same reason the schema endpoint did: the Neon connection
 * string is a Sensitive Vercel variable, write-only, so it cannot be pulled
 * locally to seed against. Rather than move a production credential out of the
 * platform, the seeding runs inside the deployment that already holds it.
 *
 * The endpoint that preceded this one was removed for being pure attack
 * surface once the schema was settled, and that reasoning still stands - so
 * this one is deliberately narrower than the one it replaces:
 *
 *   - it executes no DDL, and takes no SQL, table, or column from the caller;
 *   - the only write it can perform is inserting a `spot_photos` row for a spot
 *     that has none, from a URL that Wikimedia returned;
 *   - it is idempotent, so a replayed request is a no-op rather than damage;
 *   - `limit` is clamped, so a caller cannot turn it into an outbound flood.
 *
 * The worst a leaked token buys is photos appearing slightly sooner. Retire it
 * the same way once the catalogue is populated.
 */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * A budget under the function's own ceiling. Being killed at `maxDuration`
 * would lose the batch's summary, and the caller needs `remaining` to know
 * whether to run again.
 */
const BUDGET_MS = 50_000;

function isAuthorized(request: NextRequest): boolean {
  // CRON_SECRET is what Vercel Cron sends automatically; the explicit token is
  // for driving the initial backfill by hand.
  const expected = process.env.SEED_PHOTOS_TOKEN ?? process.env.CRON_SECRET;
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

async function run(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requested = Number(request.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // Seeding is an owner-role operation. `spot_photos` has no RLS insert policy
  // for anything but a community upload, by design - so the runtime role cannot
  // write a wikimedia row, and must not be given a policy that lets it.
  //
  // Today ADMIN_DATABASE_URL and DATABASE_URL are the same Neon string, because
  // the app still connects as `neondb_owner` (the known inert-RLS gap in
  // CLAUDE.md). Reading a separate variable now means that when that gap is
  // closed and DATABASE_URL is repointed at a non-owner role, this endpoint
  // keeps working by configuration rather than breaking silently.
  const connectionString =
    process.env.ADMIN_DATABASE_URL?.trim() || resolveConnectionString();
  if (!connectionString) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // A short-lived pool, not the request pool: this connection is privileged and
  // has no business being reused to serve a page.
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const result = await attachCommonsPhotos(pool, { limit, budgetMs: BUDGET_MS });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[seed-photos] failed", error);
    return NextResponse.json(
      { error: "seed_failed", message: (error as Error).message },
      { status: 500 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

/** POST for manual backfill; GET is what Vercel Cron issues. */
export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}
