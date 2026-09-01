import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

/**
 * Short-lived, scoped authorization tokens minted by this server, layered in
 * front of the `pg` write routes.
 *
 * A verified Firebase ID token proves *who* is calling and is valid for its
 * full remaining lifetime (up to an hour) for anything that uid can ever do -
 * Firebase custom claims are coarse and not scoped per action. This token
 * proves *that this specific action was authorized for this specific
 * request*: it is minted only after a Firebase token is verified, it expires
 * in minutes rather than an hour, and it carries an explicit scope the route
 * checks against. RLS (0003_rls.sql) remains the last line of defense on data
 * access - this is a narrower, revocable-by-expiry credential above it, not a
 * replacement for it.
 */

export type AppTokenScope = "reviews:write";

const ALGORITHM = "HS256";
const TOKEN_TTL_SECONDS = 5 * 60;

function getSecretKey(): Uint8Array {
  const secret = process.env.APP_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "APP_TOKEN_SECRET must be set to a random value of at least 32 characters.",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function mintAppToken(uid: string, scope: AppTokenScope): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

/**
 * Verifies an app token and checks it was issued to `uid` for `scope`.
 * Returns false rather than throwing for any failure - expired, malformed,
 * wrong signature, wrong uid, wrong scope - so callers have one branch to
 * handle, mirroring `getAuthedUser`'s null-on-failure shape.
 */
export async function verifyAppToken(
  token: string,
  uid: string,
  scope: AppTokenScope,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: [ALGORITHM] });
    return payload.sub === uid && payload.scope === scope;
  } catch (error) {
    if (!(error instanceof joseErrors.JOSEError)) throw error;
    return false;
  }
}
