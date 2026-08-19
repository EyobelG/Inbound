import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { verifyIdToken } from "@/lib/firebase/admin";

export interface AuthedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
}

/**
 * Extracts and verifies the caller from the Authorization header.
 *
 * Returns null rather than throwing, because most endpoints serve
 * unauthenticated readers too - the caller decides whether anonymous is
 * acceptable.
 */
export async function getAuthedUser(request: NextRequest): Promise<AuthedUser | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const decoded = await verifyIdToken(header.slice(7));
  if (!decoded) return null;

  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    displayName: (decoded.name as string | undefined) ?? null,
    photoUrl: (decoded.picture as string | undefined) ?? null,
  };
}

/**
 * Makes sure a row exists in `app_users` for this Firebase account.
 *
 * Every user-owned table has a foreign key onto `app_users`, so a first-time
 * reviewer would otherwise hit a 23503 on their very first write. Called
 * inside the same transaction as that write, so identity and content commit
 * together or not at all.
 */
export async function ensureAppUser(client: PoolClient, user: AuthedUser): Promise<void> {
  await client.query(
    `insert into app_users (firebase_uid, email, display_name, photo_url)
     values ($1, $2, $3, $4)
     on conflict (firebase_uid) do update set
       email        = coalesce(excluded.email, app_users.email),
       display_name = coalesce(excluded.display_name, app_users.display_name),
       photo_url    = coalesce(excluded.photo_url, app_users.photo_url)`,
    [user.uid, user.email, user.displayName, user.photoUrl],
  );
}
