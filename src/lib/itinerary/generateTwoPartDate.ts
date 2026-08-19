import { haversineMeters, walkingMinutes } from "@/lib/geo";
import { isOpenDuring } from "@/lib/itinerary/hours";
import {
  DomainError,
  type DateStage,
  type PriceTier,
  type Spot,
  type SpotCategory,
  type VibePriority,
} from "@/types/domain";

/**
 * Step 1 is the low-stakes opener you can leave from; Step 2 is the commitment
 * you only make if Step 1 went well. Encoding that asymmetry in the category
 * split is the whole product thesis - never let a 90-minute tasting menu be
 * proposed as a first stop.
 */
export const STEP_ONE_CATEGORIES: SpotCategory[] = ["cafe", "bar"];
export const STEP_TWO_CATEGORIES: SpotCategory[] = [
  "restaurant",
  "activity",
  "dessert",
  "walk_park",
];

/** Hard product constraint: the hop between stops must not become its own outing. */
export const MAX_HOP_METERS = 600;

const DWELL_MINUTES = { stepOne: 60, stepTwo: 75 } as const;

export interface TwoPartDateOptions {
  dateStage: DateStage;
  vibePriority: VibePriority;
  /** When the pair plans to arrive at Step 1. Defaults to now. */
  startAt?: Date;
  maxHopMeters?: number;
  maxPriceTier?: PriceTier;
  /** Stops must be within this walk of the meeting station. */
  anchorRadiusMeters?: number;
  limit?: number;
}

export interface DatePairing {
  stepOne: Spot;
  stepTwo: Spot;
  hopMeters: number;
  hopWalkMinutes: number;
  transitNote: string;
  totalDurationMinutes: number;
  budgetEstimate: number;
  score: number;
  /** Per-factor breakdown, surfaced in the UI so a suggestion is explainable. */
  rationale: {
    vibeFit: number;
    stageFit: number;
    proximity: number;
    confidence: number;
  };
}

const PRICE_ORDER: Record<PriceTier, number> = { $: 1, $$: 2, $$$: 3, $$$$: 4 };
/** Rough per-person spend by tier, USD. */
const PRICE_ESTIMATE: Record<PriceTier, number> = { $: 15, $$: 30, $$$: 60, $$$$: 110 };

/**
 * What each priority actually wants from the vibe metrics. Noise and lighting
 * both run 1 (quiet / dim) to 5 (loud / bright), so a priority is expressible
 * as a target point plus how much each axis matters.
 */
const VIBE_TARGETS: Record<
  VibePriority,
  { noise: number; lighting: number; noiseWeight: number; lightingWeight: number }
> = {
  quiet_convo:  { noise: 1.5, lighting: 3.0, noiseWeight: 1.0, lightingWeight: 0.2 },
  fun_activity: { noise: 4.0, lighting: 4.0, noiseWeight: 0.6, lightingWeight: 0.4 },
  romantic_dim: { noise: 2.0, lighting: 1.5, noiseWeight: 0.5, lightingWeight: 1.0 },
};

/** 0..1, where 1 is a perfect match for the requested vibe. */
function vibeFit(spot: Spot, priority: VibePriority): number {
  const target = VIBE_TARGETS[priority];
  const noise = spot.vibes?.avgNoiseLevel;
  const lighting = spot.vibes?.lightingScore;

  // No data is neutral, not disqualifying - otherwise nothing new is ever shown.
  if (noise == null && lighting == null) return 0.5;

  const noiseError = noise == null ? 1 : Math.abs(noise - target.noise) / 4;
  const lightingError = lighting == null ? 1 : Math.abs(lighting - target.lighting) / 4;
  const weightSum = target.noiseWeight + target.lightingWeight;
  const error =
    (noiseError * target.noiseWeight + lightingError * target.lightingWeight) / weightSum;

  return Math.max(0, 1 - error);
}

/** Share of this spot's stage votes that went to the requested stage. */
function stageFit(spot: Spot, stage: DateStage): number {
  const votes = spot.vibes?.bestForStage;
  if (!votes) return 0.5;
  const total = Object.values(votes).reduce((sum, n) => sum + n, 0);
  if (total === 0) return 0.5;
  return (votes[stage] ?? 0) / total;
}

/**
 * First dates need an exit ramp. `easy_exit_score` only earns weight for the
 * first_date stage; on an anniversary, being hard to leave is the point.
 */
function easeOfExitBonus(spot: Spot, stage: DateStage): number {
  if (stage !== "first_date") return 0;
  const score = spot.vibes?.easyExitScore;
  if (score == null) return 0;
  return ((score - 3) / 2) * 0.15;
}

/** Damps confident-looking scores that rest on one or two reviews. */
function confidence(spot: Spot): number {
  const n = spot.vibes?.totalReviewsCount ?? 0;
  return n / (n + 5); // 0.5 at 5 reviews, 0.83 at 25
}

const SCORE_WEIGHTS = { vibe: 0.4, stage: 0.3, proximity: 0.3 } as const;

function describeHop(stepOne: Spot, stepTwo: Spot, minutes: number): string {
  const sameBlock = stepOne.neighborhood === stepTwo.neighborhood;
  return sameBlock
    ? `${minutes} min walk over to ${stepTwo.name}, still in ${stepTwo.neighborhood}`
    : `${minutes} min walk from ${stepOne.neighborhood} to ${stepTwo.neighborhood}`;
}

/**
 * Pairs a low-stakes opener with a follow-on within walking distance.
 *
 * Candidates are expected to be pre-filtered by proximity to the meeting
 * station (see `spots_near_station`); this function owns pairing, vibe fit, and
 * open-hours verification only.
 */
export function generateTwoPartDate(
  candidates: Spot[],
  options: TwoPartDateOptions,
): DatePairing[] {
  const {
    dateStage,
    vibePriority,
    startAt = new Date(),
    maxHopMeters = MAX_HOP_METERS,
    maxPriceTier,
    limit = 10,
  } = options;

  if (candidates.length < 2) {
    throw new DomainError(
      "Need at least two nearby spots to build a two-part date.",
      "NO_CANDIDATES",
    );
  }

  const priceCeiling = maxPriceTier ? PRICE_ORDER[maxPriceTier] : Infinity;
  const affordable = candidates.filter((s) => PRICE_ORDER[s.priceTier] <= priceCeiling);

  const stepTwoArrival = new Date(startAt.getTime() + DWELL_MINUTES.stepOne * 60_000);

  const openers = affordable.filter(
    (s) =>
      STEP_ONE_CATEGORIES.includes(s.category) &&
      isOpenDuring(s.openingHours, startAt, DWELL_MINUTES.stepOne),
  );
  const followOns = affordable.filter(
    (s) =>
      STEP_TWO_CATEGORIES.includes(s.category) &&
      isOpenDuring(s.openingHours, stepTwoArrival, DWELL_MINUTES.stepTwo),
  );

  if (openers.length === 0 || followOns.length === 0) {
    throw new DomainError(
      "No open pairing available at that time - try a different start time or widen the radius.",
      "NO_CANDIDATES",
    );
  }

  const pairings: DatePairing[] = [];

  for (const stepOne of openers) {
    for (const stepTwo of followOns) {
      if (stepOne.id === stepTwo.id) continue;

      const hopMeters = haversineMeters(stepOne.location, stepTwo.location);
      if (hopMeters > maxHopMeters) continue;

      // Linear falloff: at the cap the hop contributes nothing, next door is 1.
      const proximity = 1 - hopMeters / maxHopMeters;

      const pairVibeFit = (vibeFit(stepOne, vibePriority) + vibeFit(stepTwo, vibePriority)) / 2;
      const pairStageFit = (stageFit(stepOne, dateStage) + stageFit(stepTwo, dateStage)) / 2;
      const pairConfidence = (confidence(stepOne) + confidence(stepTwo)) / 2;

      const base =
        SCORE_WEIGHTS.vibe * pairVibeFit +
        SCORE_WEIGHTS.stage * pairStageFit +
        SCORE_WEIGHTS.proximity * proximity;

      // Confidence never fully suppresses an unreviewed spot; it scales the
      // portion of the score that came from crowd data, leaving proximity intact.
      const score =
        base * (0.7 + 0.3 * pairConfidence) + easeOfExitBonus(stepOne, dateStage);

      const hopWalkMinutes = walkingMinutes(hopMeters);

      pairings.push({
        stepOne,
        stepTwo,
        hopMeters: Math.round(hopMeters),
        hopWalkMinutes,
        transitNote: describeHop(stepOne, stepTwo, hopWalkMinutes),
        totalDurationMinutes:
          DWELL_MINUTES.stepOne + hopWalkMinutes + DWELL_MINUTES.stepTwo,
        budgetEstimate:
          PRICE_ESTIMATE[stepOne.priceTier] + PRICE_ESTIMATE[stepTwo.priceTier],
        score,
        rationale: {
          vibeFit: pairVibeFit,
          stageFit: pairStageFit,
          proximity,
          confidence: pairConfidence,
        },
      });
    }
  }

  if (pairings.length === 0) {
    throw new DomainError(
      `No two open spots were within ${maxHopMeters}m of each other.`,
      "NO_CANDIDATES",
    );
  }

  // Diversify: a results list where every row opens at the same cafe is one
  // suggestion wearing ten hats.
  const seenOpeners = new Map<string, number>();
  return pairings
    .sort((a, b) => b.score - a.score)
    .filter((p) => {
      const count = seenOpeners.get(p.stepOne.id) ?? 0;
      if (count >= 2) return false;
      seenOpeners.set(p.stepOne.id, count + 1);
      return true;
    })
    .slice(0, limit);
}
