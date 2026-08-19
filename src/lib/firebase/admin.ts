import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

/**
 * Server-side Firebase Admin, used only to verify ID tokens. Credentials come
 * from a service account; on Cloud Run / App Hosting the ambient service
 * account is used instead and FIREBASE_SERVICE_ACCOUNT_KEY can be omitted.
 */
function getAdminApp(): App {
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    // Application Default Credentials path.
    return initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID });
  }

  let parsed: { project_id: string; client_email: string; private_key: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON.");
  }

  return initializeApp({
    credential: cert({
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      // Env vars flatten newlines; the PEM parser needs them back.
      privateKey: parsed.private_key.replace(/\\n/g, "\n"),
    }),
  });
}

/**
 * Verifies a Firebase ID token. `checkRevoked` is on so a signed-out or
 * disabled account stops being able to write immediately rather than for the
 * remaining lifetime of its token.
 */
export async function verifyIdToken(token: string): Promise<DecodedIdToken | null> {
  try {
    return await getAuth(getAdminApp()).verifyIdToken(token, true);
  } catch (error) {
    // An invalid or expired token is an ordinary unauthenticated request, not
    // a server fault - log at debug volume and let the caller return 401.
    console.debug("[auth] token verification failed", (error as Error).message);
    return null;
  }
}

export function isFirebaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
  );
}
