import { describe, expect, test } from "bun:test";
import { seasonalAccentFor } from "../src/lib/features/navigation/seasonal-accents.ts";

describe("seasonal accents in the client's local calendar", () => {
  test("starts at midnight on December 1", () => {
    expect(seasonalAccentFor(new Date(2026, 10, 30, 23, 59, 59, 999))).toBeNull();
    expect(seasonalAccentFor(new Date(2026, 11, 1))).toBe("snow");
  });

  test("continues into January and ends at midnight on January 7", () => {
    expect(seasonalAccentFor(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe("snow");
    expect(seasonalAccentFor(new Date(2027, 0, 1))).toBe("snow");
    expect(seasonalAccentFor(new Date(2027, 0, 6, 23, 59, 59, 999))).toBe("snow");
    expect(seasonalAccentFor(new Date(2027, 0, 7))).toBeNull();
  });

  test("returns to neutral outside the period and repeats the next year", () => {
    expect(seasonalAccentFor(new Date(2027, 6, 15))).toBeNull();
    expect(seasonalAccentFor(new Date(2027, 11, 1))).toBe("snow");
  });
});
