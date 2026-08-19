import { describe, expect, it } from "vitest";
import { parseOsmOpeningHours } from "../hours";

describe("parseOsmOpeningHours", () => {
  it("expands a weekday range", () => {
    const w = parseOsmOpeningHours("Mo-Fr 08:00-18:00");
    expect(w).toHaveLength(5);
    expect(w.map((x) => x.day).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(w[0]).toMatchObject({ open: "08:00", close: "18:00" });
  });

  it("handles multiple rules", () => {
    const w = parseOsmOpeningHours("Mo-Th 11:00-22:00; Fr-Sa 11:00-23:00; Su 12:00-21:00");
    expect(w).toHaveLength(7);
    expect(w.find((x) => x.day === 0)).toMatchObject({ open: "12:00", close: "21:00" });
    expect(w.find((x) => x.day === 6)).toMatchObject({ close: "23:00" });
  });

  it("folds a past-midnight close onto a 24h clock", () => {
    // Bars are the reason: 26:00 means 2am the next day.
    const w = parseOsmOpeningHours("Fr-Sa 17:00-26:00");
    expect(w[0]).toMatchObject({ open: "17:00", close: "02:00" });
  });

  it("wraps a day range that crosses Sunday", () => {
    const w = parseOsmOpeningHours("Fr-Mo 10:00-14:00");
    expect(w.map((x) => x.day).sort()).toEqual([0, 1, 5, 6]);
  });

  it("expands 24/7", () => {
    expect(parseOsmOpeningHours("24/7")).toHaveLength(7);
  });

  it("returns empty rather than guess at grammar it cannot parse", () => {
    // Empty means "unknown", which isOpenDuring treats as open - far safer
    // than inventing hours that hide a venue from every search.
    expect(parseOsmOpeningHours("Mo-Fr 08:00-18:00; PH off")).toEqual([]);
    expect(parseOsmOpeningHours("sunrise-sunset")).toEqual([]);
    expect(parseOsmOpeningHours("Mo-Fr")).toEqual([]);
    expect(parseOsmOpeningHours(undefined)).toEqual([]);
  });
});
