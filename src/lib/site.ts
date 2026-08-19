/**
 * Site-level identity and attribution.
 *
 * Single source of truth so the header, footer, and page metadata can never
 * disagree about who built this or where to find them.
 */
export const SITE = {
  name: "Inbound",
  tagline: "Two stops, one fair meeting point.",
  description:
    "Transit-aware date itineraries for Boston, Cambridge, and Somerville — " +
    "fair MBTA meeting points and crowdsourced vibe metrics.",
  author: {
    name: "Eyobel Gebre",
    github: "https://github.com/EyobelG",
    linkedin: "https://www.linkedin.com/in/eyobelgebre/",
  },
  // The header's GitHub icon links to the source, not the profile - matching
  // the convention used across the author's other projects.
  repo: "https://github.com/EyobelG/Inbound",
} as const;

/** Only routes that actually exist - a nav link to a 404 is worse than no link. */
export const NAV_LINKS = [
  { href: "/", label: "Plan" },
  { href: "/about", label: "About" },
] as const;
