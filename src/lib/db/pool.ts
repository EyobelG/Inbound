import { Pool, type PoolClient, type QueryResultRow } from "pg";

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

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  return new Pool({
    connectionString,
    // Cloud SQL terminates TLS with its own CA. In production, point
    // PGSSLROOTCERT at the server-ca.pem and drop rejectUnauthorized.
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX ?? 10),
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
  return Boolean(process.env.DATABASE_URL);
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
