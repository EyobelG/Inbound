import { NextResponse, type NextRequest } from "next/server";

export const revalidate = 86_400;

const MAX_WIDTH = 1200;

/**
 * Proxies Google Places photo media.
 *
 * Places photo URLs require the API key as a query parameter, so linking them
 * directly from the browser would publish the key to every visitor. This route
 * keeps the key server-side and hands back only the redirect target.
 *
 * The resource name is validated rather than passed through: without it, this
 * endpoint is an open redirect / SSRF pivot to any host an attacker names.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string[] }> },
) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: { code: "NOT_CONFIGURED", message: "Photo proxy is unavailable." } },
      { status: 503 },
    );
  }

  const { name } = await context.params;
  const resource = name.join("/");

  // Places photo resources are always `places/<id>/photos/<photoId>`.
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(resource)) {
    return NextResponse.json(
      { error: { code: "INVALID_RESOURCE", message: "Not a Places photo resource." } },
      { status: 400 },
    );
  }

  const widthParam = Number(request.nextUrl.searchParams.get("w") ?? 800);
  const width = Number.isFinite(widthParam)
    ? Math.min(Math.max(Math.trunc(widthParam), 64), MAX_WIDTH)
    : 800;

  const upstream = new URL(`https://places.googleapis.com/v1/${resource}/media`);
  upstream.searchParams.set("maxWidthPx", String(width));
  upstream.searchParams.set("skipHttpRedirect", "true");
  upstream.searchParams.set("key", key);

  try {
    const response = await fetch(upstream, { next: { revalidate } });
    if (!response.ok) {
      return NextResponse.json(
        { error: { code: "UPSTREAM_ERROR", message: "Photo unavailable." } },
        { status: response.status === 404 ? 404 : 502 },
      );
    }

    // skipHttpRedirect returns the signed URI as JSON instead of a 302, so the
    // image bytes stream straight from Google's CDN rather than through us.
    const body = (await response.json()) as { photoUri?: string };
    if (!body.photoUri) {
      return NextResponse.json(
        { error: { code: "UPSTREAM_ERROR", message: "Photo unavailable." } },
        { status: 502 },
      );
    }

    return NextResponse.redirect(body.photoUri, {
      status: 307,
      headers: { "Cache-Control": "public, max-age=86400, immutable" },
    });
  } catch (error) {
    console.error("[photos] proxy failed", error);
    return NextResponse.json(
      { error: { code: "UPSTREAM_ERROR", message: "Photo unavailable." } },
      { status: 502 },
    );
  }
}
