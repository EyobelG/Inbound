import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { ConnectionOptions } from "node:tls";

/**
 * Connection pool against the Cloud SQL Postgres instance backing Firebase
 * Data Connect.
 *
 * We talk to Postgres directly rather than through Data Connect's generated
 * GraphQL SDK because the spatial core - ST_DWithin, the GIST indexes, the
 * aggregate triggers, and the `spots_near_station` function - is not
 * expressible in Data Connect's schema language. Data Connect's SDK remains a
 * fine fit for plain CRUD if that is added later; both talk to the same
 * database.
 */
declare global {
  // eslint-disable-next-line no-var
  var __inboundPool: Pool | undefined;
}

/**
 * Connection string, resolved from the names hosting providers actually inject.
 *
 * `DATABASE_URL` is ours. `POSTGRES_URL` is what Vercel's Postgres and Neon
 * marketplace integrations create by default, and requiring a manual copy from
 * one to the other is a step that silently half-works: the dashboard shows a
 * populated variable while the app reads an empty one.
 *
 * Deliberately a short, documented list - not a prefix search. A fuzzy match
 * would pick up whichever variable happened to be named closest, which is
 * worse than failing loudly.
 */
const CONNECTION_STRING_VARS = ["DATABASE_URL", "POSTGRES_URL"] as const;

export function resolveConnectionString(): string | undefined {
  for (const name of CONNECTION_STRING_VARS) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The production instance is Neon, which - unlike Cloud SQL - terminates TLS
 * with the public ISRG Root X1 (Let's Encrypt) certificate, already present
 * in Node's default trust store. So the default here is to verify
 * (`rejectUnauthorized: true`) with no custom CA at all; `PGSSLROOTCERT` is
 * an escape hatch only for a provider with a private CA (e.g. real Cloud
 * SQL), where the server's cert isn't in any public trust store to begin
 * with. There is deliberately no unverified fallback: an app that can't
 * verify its database's certificate should fail to connect, not connect
 * blind to a MITM.
 */
function resolveSslConfig(): ConnectionOptions | false {
  if (process.env.PGSSLMODE === "disable") return false;

  const caPath = process.env.PGSSLROOTCERT?.trim();
  return {
    rejectUnauthorized: true,
    ca: caPath ? readFileSync(caPath, "utf8") : undefined,
  };
}

function createPool(): Pool {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error(
      `No database connection string. Set one of: ${CONNECTION_STRING_VARS.join(", ")}`,
    );
  }

  return new Pool({
    connectionString,
    ssl: resolveSslConfig(),
    // `??` is not enough: a variable defined with a blank value is a string,
    // not undefined, and Number("") is 0 - a pool that can never hand out a
    // connection. Treat blank and non-numeric as "not set".
    max: positiveIntEnv("PGPOOL_MAX", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Reuse the pool across hot reloads. Without this, every dev-server recompile
 * leaks a pool and Postgres runs out of connections within minutes.
 */
export function getPool(): Pool {
  if (!global.__inboundPool) global.__inboundPool = createPool();
  return global.__inboundPool;
}

export function isDatabaseConfigured(): boolean {
  return resolveConnectionString() !== undefined;
}

/**
 * Runs a callback inside a transaction with `app.firebase_uid` set, which is
 * what every RLS policy in 0003_rls.sql reads.
 *
 * This is the ONLY function permitted to set that variable, and `uid` must
 * come from a verified Firebase ID token - never from a request body or
 * header. `SET LOCAL` scopes it to the transaction, so a pooled connection
 * cannot leak one user's identity into the next request that borrows it.
 */
export async function withUser<T>(
  uid: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // Parameterized: a uid is attacker-influenced input even after verification.
    await client.query("select set_config('app.firebase_uid', $1, true)", [uid ?? ""]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {
      // The connection is already broken; the pool will discard it.
    });
    throw error;
  } finally {
    client.release();
  }
}

/** Convenience for a single anonymous read. */
export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await getPool().query<T>(sql, params);
  return rows;
}
