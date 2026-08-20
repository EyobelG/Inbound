/**
 * Shared matching rules for Wikimedia-sourced content.
 *
 * Two seeders depend on deciding whether a Wikipedia article is really about a
 * given venue - one attaches photos, the other bootstraps inventory - and they
 * must agree. A venue that is too ambiguous to photograph is equally too
 * ambiguous to insert as a spot, so the rule lives here rather than in either
 * script.
 */

/** Commons serves plenty of images too small to survive a 224px-tall card. */
export const MIN_WIDTH_PX = 640;
export const THUMB_WIDTH_PX = 1200;

/**
 * Filenames that are reliably not venue photography. Mapillary dominates the
 * geotagged corpus in Boston and is the single most common false positive.
 */
export const REJECTED_TITLE_PATTERNS = [
  /mapillary/i,
  /\bseal\b|\bcoat of arms\b|\blogo\b|\bwordmark\b|\bicon\b/i,
  /\bmap\b|\bdiagram\b|\bfloor ?plan\b|\bblueprint\b/i,
  /\bportrait\b|\bheadshot\b/i,
  /\bplaque\b|\bsignage only\b/i,
];

/** Vector and document formats are logos and scans, never venue photos. */
export const REJECTED_EXTENSIONS = /\.(svg|pdf|djvu|tif|tiff|ogv|webm|gif)$/i;

export function significantWords(value: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "of", "and", "at", "in", "on", "cafe", "bar", "restaurant",
    "boston", "cambridge", "somerville", "co", "company", "house", "massachusetts",
  ]);
  return value
    .toLowerCase()
    // Decompose accents first: stripping "café" without this leaves the junk
    // token "caf", which slips past the "cafe" stop word and then counts as a
    // mismatched word against the venue name.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

/**
 * Guards against Wikipedia's search happily returning a tangentially related
 * article. The match must hold in both directions, because each direction
 * catches a different failure seen in practice:
 *
 *   - venue -> article rejects "Trident Booksellers" resolving to "List of
 *     booksellers in Boston", which shares only one token.
 *   - article -> venue rejects "Museum of Fine Arts" resolving to "School of
 *     the Museum of Fine Arts - Tufts University". Every venue word appears, so
 *     a one-way test passes it, yet the article is about a different building.
 *     Requiring the article to be mostly accounted for by the venue name is
 *     what separates the museum from the art school attached to it.
 */
export function titleMatchesVenue(venueName: string, articleTitle: string): boolean {
  const venueWords = significantWords(venueName);
  const articleWords = significantWords(articleTitle);
  if (venueWords.length === 0 || articleWords.length === 0) return false;

  const articleText = articleWords.join(" ");
  const venueHits = venueWords.filter((word) => articleText.includes(word)).length;
  // A single-token name has to match that token outright; multi-token names
  // tolerate one miss so "Trident Booksellers Cafe" still finds "Trident".
  const enoughWords =
    venueWords.length === 1 ? venueHits === 1 : venueHits >= Math.max(2, venueWords.length - 1);

  // The leading significant word is the venue's own name; everything after it
  // tends to be locality or category. Counting words alone lets exactly that
  // name be the one that is missing - "Cheers Beacon Hill" scores two hits
  // against the article "Beacon Hill, Boston" and returns a street photo. The
  // brand has to be present, not merely outvoted by its address.
  const forward = enoughWords && articleText.includes(venueWords[0]!);

  const venueText = venueWords.join(" ");
  const articleHits = articleWords.filter((word) => venueText.includes(word)).length;
  const backward = articleHits / articleWords.length >= 0.7;

  return forward && backward;
}

export function isPlausibleVenuePhoto(fileTitle: string): boolean {
  if (REJECTED_EXTENSIONS.test(fileTitle)) return false;
  // Wikipedia hands back `pageimage` with underscores for spaces, and an
  // underscore is a word character - so `\blogo\b` silently fails to fire on
  // "Annas_Taqueria_logo.png" and a brand mark reaches the card. Normalise the
  // separators before any word-boundary rule is applied.
  const readable = fileTitle.replace(/_/g, " ");
  return !REJECTED_TITLE_PATTERNS.some((pattern) => pattern.test(readable));
}
