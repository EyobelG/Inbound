/**
 * Domain vocabulary. These string unions mirror the Postgres enums in
 * firebase/schema/0001_schema.sql exactly - if you change one, change both.
 */

export const MBTA_LINES = [
  "red", "green_b", "green_c", "green_d", "green_e", "orange", "blue",
] as const;
export type MbtaLine = (typeof MBTA_LINES)[number];

export const SPOT_CATEGORIES = [
  "bar", "cafe", "activity", "dessert", "restaurant", "walk_park",
] as const;
export type SpotCategory = (typeof SPOT_CATEGORIES)[number];

export const PRICE_TIERS = ["$", "$$", "$$$", "$$$$"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const DATE_STAGES = [
  "first_date", "second_or_third", "established_exclusive", "anniversary",
] as const;
export type DateStage = (typeof DATE_STAGES)[number];

export const SEASONS = ["all_year", "summer_fall", "winter_cozy"] as const;
export type Season = (typeof SEASONS)[number];

/** What the planner bar optimizes for. Maps onto vibe thresholds, not tags. */
export const VIBE_PRIORITIES = ["quiet_convo", "fun_activity", "romantic_dim"] as const;
export type VibePriority = (typeof VIBE_PRIORITIES)[number];

export interface LngLat {
  lng: number;
  lat: number;
}

export interface Station {
  id: string;
  gtfsStopId: string;
  stopName: string;
  line: MbtaLine;
  branch: string | null;
  orderIndex: number;
  location: LngLat;
  isAccessible: boolean;
}

/** 1.0 = whisper quiet / candlelit / hard to leave; 5.0 = shouting / daylight / easy exit. */
export interface SpotVibes {
  avgNoiseLevel: number | null;
  lightingScore: number | null;
  easyExitScore: number | null;
  bestForStage: Record<DateStage, number>;
  totalReviewsCount: number;
}

export interface SpotPhoto {
  id: string;
  url: string;
  caption: string | null;
  source: "google_places" | "community_upload" | "wikimedia";
  displayOrder: number;
  /**
   * Author, licence, and file page for openly licensed imagery. Populated only
   * for `wikimedia` rows, where CC-BY / CC-BY-SA make displaying all three a
   * condition of use rather than a nicety - the database refuses a wikimedia
   * row that lacks them (`spot_photos_source_provenance`).
   */
  attribution: string | null;
  license: string | null;
  sourcePageUrl: string | null;
}

export interface OpeningWindow {
  /** 0 = Sunday. */
  day: number;
  /** "HH:MM", 24h. `close` < `open` means the window runs past midnight. */
  open: string;
  close: string;
}

export interface Spot {
  id: string;
  name: string;
  slug: string;
  neighborhood: string;
  address: string;
  location: LngLat;
  priceTier: PriceTier;
  category: SpotCategory;
  nearestStationId: string | null;
  walkingMinutesToT: number | null;
  googlePlaceId: string | null;
  openingHours: OpeningWindow[];
  isVerified: boolean;
  vibes: SpotVibes | null;
  photos: SpotPhoto[];
  /** Most-upvoted review body, surfaced on the card. */
  topQuote: { body: string; helpfulCount: number; dateStage: DateStage } | null;
  /** Present on results that came from a proximity query. */
  distanceMeters?: number;
  walkingMinutes?: number;
}

export interface ItineraryStop {
  id: string;
  spot: Spot;
  stepOrder: number;
  transitNote: string | null;
  customTip: string | null;
}

export interface Itinerary {
  id: string;
  creatorId: string;
  title: string;
  description: string | null;
  totalDurationMinutes: number | null;
  budgetEstimate: number | null;
  season: Season;
  upvotesCount: number;
  stops: ItineraryStop[];
}

/** Thrown by lib code for conditions the API layer maps to 4xx. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code:
      | "STATION_NOT_FOUND"
      | "NO_ROUTE"
      | "NO_CANDIDATES"
      | "INVALID_INPUT",
  ) {
    super(message);
    this.name = "DomainError";
  }
}
