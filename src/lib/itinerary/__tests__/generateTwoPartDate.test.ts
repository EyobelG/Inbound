import { describe, expect, it } from "vitest";
import { generateTwoPartDate, MAX_HOP_METERS } from "../generateTwoPartDate";
import { isOpenDuring } from "../hours";
import { DomainError, type Spot, type SpotCategory } from "@/types/domain";

let counter = 0;
function spot(
  category: SpotCategory,
  overrides: Partial<Spot> = {},
): Spot {
  return {
    id: `spot-${counter++}`,
    name: `Spot ${counter}`,
    slug: `spot-${counter}`,
    neighborhood: "Central Sq",
    address: "1 Main St",
    location: { lng: -71.1, lat: 42.365 },
    priceTier: "$$",
    category,
    nearestStationId: null,
    walkingMinutesToT: 3,
    googlePlaceId: null,
    openingHours: [],
    isVerified: true,
    vibes: null,
    photos: [],
    topQuote: null,
    ...overrides,
  };
}

/** ~0.0121 degrees of longitude at this latitude is ~1000m. */
function shiftedEast(meters: number) {
  return { lng: -71.1 + meters * 0.0000121, lat: 42.365 };
}

describe("generateTwoPartDate", () => {
  const options = { dateStage: "first_date", vibePriority: "quiet_convo" } as const;

  it("pairs an opener with a follow-on inside the walk radius", () => {
    const cafe = spot("cafe");
    const restaurant = spot("restaurant", { location: shiftedEast(300) });

    const results = generateTwoPartDate([cafe, restaurant], options);

    expect(results).toHaveLength(1);
    expect(results[0]!.stepOne.id).toBe(cafe.id);
    expect(results[0]!.stepTwo.id).toBe(restaurant.id);
    expect(results[0]!.hopMeters).toBeLessThanOrEqual(MAX_HOP_METERS);
  });

  it("rejects pairs beyond the walk cap", () => {
    const cafe = spot("cafe");
    const restaurant = spot("restaurant", { location: shiftedEast(1200) });

    expect(() => generateTwoPartDate([cafe, restaurant], options)).toThrow(DomainError);
  });

  it("never proposes a restaurant as the opener", () => {
    const restaurantA = spot("restaurant");
    const restaurantB = spot("restaurant", { location: shiftedEast(200) });

    expect(() => generateTwoPartDate([restaurantA, restaurantB], options)).toThrow(
      /No open pairing/,
    );
  });

  it("ranks the quieter pair first when the vibe is quiet_convo", () => {
    const quietCafe = spot("cafe", {
      vibes: {
        avgNoiseLevel: 1.5, lightingScore: 3, easyExitScore: 4,
        bestForStage: { first_date: 10, second_or_third: 0, established_exclusive: 0, anniversary: 0 },
        totalReviewsCount: 10,
      },
    });
    const loudBar = spot("bar", {
      location: shiftedEast(50),
      vibes: {
        avgNoiseLevel: 4.8, lightingScore: 3, easyExitScore: 4,
        bestForStage: { first_date: 10, second_or_third: 0, established_exclusive: 0, anniversary: 0 },
        totalReviewsCount: 10,
      },
    });
    const restaurant = spot("restaurant", { location: shiftedEast(250) });

    const results = generateTwoPartDate([quietCafe, loudBar, restaurant], options);
    expect(results[0]!.stepOne.id).toBe(quietCafe.id);
  });

  it("caps how many times one opener can appear", () => {
    const cafe = spot("cafe");
    const followOns = Array.from({ length: 5 }, (_, i) =>
      spot("restaurant", { location: shiftedEast(100 + i * 20) }),
    );

    const results = generateTwoPartDate([cafe, ...followOns], options);
    expect(results.filter((r) => r.stepOne.id === cafe.id)).toHaveLength(2);
  });
});

describe("isOpenDuring", () => {
  // Saturday 2024-06-01 is day 6; Sunday 2024-06-02 is day 0.
  const saturdayEvening = new Date("2024-06-01T20:00:00");
  const sundayLateNight = new Date("2024-06-02T00:30:00");

  it("treats unknown hours as open", () => {
    expect(isOpenDuring([], saturdayEvening, 60)).toBe(true);
  });

  it("accepts a stay inside a normal window", () => {
    expect(isOpenDuring([{ day: 6, open: "17:00", close: "23:00" }], saturdayEvening, 60)).toBe(true);
  });

  it("rejects a stay that runs past closing", () => {
    expect(isOpenDuring([{ day: 6, open: "17:00", close: "20:30" }], saturdayEvening, 60)).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    // Saturday 17:00-02:00 must still cover a 00:30 arrival on Sunday.
    expect(isOpenDuring([{ day: 6, open: "17:00", close: "02:00" }], sundayLateNight, 60)).toBe(true);
  });
});
