import { describe, expect, test } from "bun:test";
import { disclosureOffset, disclosurePosition } from "../../apps/mobile/src/ui/disclosure-anchor";

describe("inverted mobile disclosure anchoring", () => {
  test("a stale scroll checkpoint cannot compound corrections during expansion or collapse", () => {
    const before = disclosurePosition(600, 400, 100, 150);
    const expanded = disclosurePosition(600, 700, -200, -150);
    // The same layout measured before and after the native scroll checkpoint catches up.
    const caughtUp = disclosurePosition(600, 700, 100, 150);

    expect(expanded).toBe(caughtUp);
    expect(disclosureOffset(500, before, expanded, 0)).toBe(800);
    expect(disclosureOffset(500, before, caughtUp, 0)).toBe(800);
    expect(disclosureOffset(800, expanded, before, 0)).toBe(500);
  });

  test("keeps a nested header fixed when layout changes above it or before its turn", () => {
    const before = disclosurePosition(600, 400, 100, 250);
    // 80 points added above the header within the turn do not move the content below it.
    expect(disclosurePosition(600, 480, 20, 250)).toBe(before);
    // A newer cell grows by 120; compensate even though this turn's height is unchanged.
    const after = disclosurePosition(720, 400, -20, 130);
    expect(disclosureOffset(500, before, after, 0)).toBe(620);
  });

  test("follows the tapped header away from the end and respects each platform's lower bound", () => {
    expect(disclosureOffset(-180, 400, 700, -180)).toBe(120);
    expect(disclosureOffset(0, 400, 700, 0)).toBe(300);
    expect(disclosureOffset(100, 700, 300, -180)).toBe(-180);
    expect(disclosureOffset(100, 700, 300, 0)).toBe(0);
    // Reversing an unfinished expansion targets the original position, without accumulated deltas.
    expect(disclosureOffset(500, 400, 450, 0)).toBe(550);
    expect(disclosureOffset(500, 400, 400, 0)).toBe(500);
  });
});
