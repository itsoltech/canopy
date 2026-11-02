/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { clampSize, keySize, RESIZE_BIG_STEP, RESIZE_STEP } from "./resize-handle.ts";

const range = { min: 220, max: 560, reset: 288 };

describe("resize handle", () => {
  test("sizes stay within the range, in whole pixels", () => {
    expect(clampSize(100, range)).toBe(220);
    expect(clampSize(900, range)).toBe(560);
    expect(clampSize(300.4, range)).toBe(300);
  });

  test("arrows step, Shift steps further, and the ends hold", () => {
    expect(keySize("ArrowRight", false, 288, range)).toBe(288 + RESIZE_STEP);
    expect(keySize("ArrowLeft", false, 288, range)).toBe(288 - RESIZE_STEP);
    expect(keySize("ArrowRight", true, 288, range)).toBe(288 + RESIZE_BIG_STEP);
    expect(keySize("ArrowUp", false, 288, range)).toBe(288 + RESIZE_STEP);
    expect(keySize("ArrowDown", true, 288, range)).toBe(288 - RESIZE_BIG_STEP);
    expect(keySize("ArrowLeft", true, 240, range)).toBe(220);
    expect(keySize("ArrowRight", true, 540, range)).toBe(560);
  });

  test("a panel on the right grows with ArrowLeft", () => {
    expect(keySize("ArrowLeft", false, 288, range, "ArrowLeft")).toBe(288 + RESIZE_STEP);
    expect(keySize("ArrowRight", false, 288, range, "ArrowLeft")).toBe(288 - RESIZE_STEP);
  });

  test("Home / End jump to the ends, Enter resets, other keys are left alone", () => {
    expect(keySize("Home", false, 400, range)).toBe(220);
    expect(keySize("End", false, 400, range)).toBe(560);
    expect(keySize("Enter", false, 400, range)).toBe("reset");
    expect(keySize("a", false, 400, range)).toBeUndefined();
    expect(keySize("Tab", false, 400, range)).toBeUndefined();
  });
});
