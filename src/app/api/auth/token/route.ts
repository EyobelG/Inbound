import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthedUser } from "@/lib/auth";
import { mintAppToken, type AppTokenScope } from "@/lib/auth/appToken";
import { toErrorResponse } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * Scopes any authenticated uid may request for itself. There is no per-user
 * entitlement check here because every scope currently maps to "act as
 * yourself" (e.g. write your own review) - the point of this endpoint is
 * narrowing a broad, hour-long Firebase token down to a short-lived,
 * single-purpose one, not granting privilege beyond what the uid already has.
 */
const REQUESTABLE_SCOPES: readonly AppTokenScope[] = ["reviews:write"];

const TokenInput = z.object({
  scope: z.enum(REQUESTABLE_SCOPES as [AppTokenScope, ...AppTokenScope[]]),
});

/**
 * POST /api/auth/token
 *
 * Exchanges a verified Firebase ID token for a short-lived (5 minute) app
 * token scoped to one action. Callers pass the resulting token on the
 * `X-App-Token` header to the route that action guards; see
 * `src/lib/auth/appToken.ts` for why this exists alongside RLS.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Sign in to request a token." } },
        { status: 401 },
      );
    }

    const { scope } = TokenInput.parse(await request.json());
    const token = await mintAppToken(user.uid, scope);

    return NextResponse.json({ token, scope, expires_in: 300 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
