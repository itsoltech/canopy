import { describe, expect, test } from "bun:test";
import { canAnimate, clampEyes, eyeLimits, eyeOffset, idleBounds, idleDelay } from "./behaviour-math.ts";
import { mascotFor, mascotShapes } from "./mascot.ts";

describe("mascot eye movement", () => {
  for (const shape of mascotShapes) test(`${shape.id}: bounded in every direction, including diagonals`, () => {
    const limit = eyeLimits(shape);
    expect(eyeOffset(0, 0, shape)).toEqual({ x: 0, y: 0 });
    for (const dx of [-10000, -120, 0, 120, 10000]) for (const dy of [-10000, -120, 0, 120, 10000]) {
      const offset = eyeOffset(dx, dy, shape);
      expect(Math.hypot(offset.x / limit.x, offset.y / limit.y)).toBeLessThanOrEqual(1.00000001);
      expect(Math.sign(offset.x)).toBe(Math.sign(dx));
      expect(Math.sign(offset.y)).toBe(Math.sign(dy));
    }
  });
  test("narrow faces have smaller envelopes; small movements are proportional", () => {
    expect(eyeLimits(mascotShapes.find((s) => s.id === "spark")!)).toEqual({ x: 0.6, y: 0.35 });
    const round = mascotShapes[0];
    expect(eyeOffset(60, 0, round)).toEqual({ x: 0.6, y: 0 });
    expect(eyeOffset(-60, 0, round)).toEqual({ x: -0.6, y: 0 });
    expect(clampEyes({ x: NaN, y: Infinity }, eyeLimits(round))).toEqual({ x: 0, y: 0 });
  });
  test("legacy pupils stay inside the sclera with their original gaze", () => {
    for (let id = 0; id < 60; id++) {
      const mascot = mascotFor(`legacy-${id}`);
      const offset = eyeOffset(10000, 10000, mascot.shape, true);
      expect(Math.hypot(Math.abs(mascot.gaze * 0.9) + offset.x, 0.4 + offset.y) + 1.6).toBeLessThan(3.2);
    }
  });
});

test("idle schedules sample independent, bounded intervals", () => {
  for (const kind of ["blink", "glance"] as const) {
    const [min, max] = idleBounds[kind];
    expect(idleDelay(kind, () => 0)).toBe(min);
    expect(idleDelay(kind, () => 1)).toBe(max);
    expect(idleDelay(kind, () => 0.25)).toBe(min + (max - min) / 4);
    for (let i = 0; i < 100; i++) {
      const delay = idleDelay(kind);
      expect(delay).toBeGreaterThanOrEqual(min);
      expect(delay).toBeLessThanOrEqual(max);
    }
    expect(new Set(Array.from({ length: 30 }, () => idleDelay(kind))).size).toBeGreaterThan(1);
  }
});

test("all motion is gated by reduced motion, preference, visibility and actual size", () => {
  expect(canAnimate({ size: 24 })).toBe(true);
  for (const size of [16, 20, 23.9]) expect(canAnimate({ size })).toBe(false);
  for (const state of [{ reduced: true }, { alive: false }, { hidden: true }, { visible: false }]) {
    expect(canAnimate({ size: 160, ...state })).toBe(false);
  }
  expect(canAnimate({ reduced: true, alive: true })).toBe(false);
});
