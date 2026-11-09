import { describe, expect, test } from "bun:test";
import { sheetDragDistance, sheetDragOffset, shouldDismissSheet } from "../../apps/mobile/src/ui/sheet-gesture";
import { shouldMoveSheetResponder, shouldStartSheetResponder } from "../../apps/mobile/src/ui/sheet-responder";

describe("sheet responder negotiation", () => {
  const touch = { numberActiveTouches: 1, dx: 0, dy: 0 };

  test("claims plain grabber/header touches at start while leaving controls and content alone", () => {
    expect(shouldStartSheetResponder(touch, "drag-area")).toBe(true);
    expect(shouldStartSheetResponder(touch, "header-control")).toBe(false);
    expect(shouldStartSheetResponder(touch, "content")).toBe(false);
    expect(shouldStartSheetResponder({ ...touch, numberActiveTouches: 0 }, "drag-area")).toBe(false);
    expect(shouldStartSheetResponder({ ...touch, numberActiveTouches: 2 }, "drag-area")).toBe(false);
  });

  test("requires deliberate vertical movement before moving chrome or capturing a header button", () => {
    for (const target of ["drag-area", "header-control"] as const) {
      expect(shouldMoveSheetResponder(touch, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dy: 6 }, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dx: 2, dy: 7 }, target)).toBe(true);
      expect(shouldMoveSheetResponder({ ...touch, dx: 2, dy: -7 }, target)).toBe(true);
      expect(shouldMoveSheetResponder({ ...touch, dx: 8, dy: 7 }, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dx: -7, dy: -7 }, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dy: 30, numberActiveTouches: 2 }, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dy: 30, numberActiveTouches: 0 }, target)).toBe(false);
      expect(shouldMoveSheetResponder({ ...touch, dy: 7 }, target, 8)).toBe(false);
    }

    expect(shouldMoveSheetResponder({ ...touch, dy: 30 }, "content")).toBe(false);
  });
});

describe("sheet release", () => {
  test("uses the measured height and a deliberate downward fling", () => {
    expect(shouldDismissSheet(167, 600, 0)).toBe(false);
    expect(shouldDismissSheet(168, 600, 0)).toBe(true);
    expect(shouldDismissSheet(168, 900, 0)).toBe(false);
    expect(shouldDismissSheet(8, 600, 900)).toBe(true);
    expect(shouldDismissSheet(7, 600, 1200)).toBe(false);
    expect(shouldDismissSheet(40, 600, 899)).toBe(false);
    expect(shouldDismissSheet(300, 600, -400)).toBe(false);
    expect(shouldDismissSheet(-30, 600, 1200)).toBe(false);
    expect(shouldDismissSheet(30, 0, 1200)).toBe(false);
  });

  test("follows downward motion exactly and rubber-bands upward without a discontinuity", () => {
    expect(sheetDragOffset(0, 600)).toBe(0);
    expect(sheetDragOffset(220, 600)).toBe(220);
    expect(sheetDragOffset(-0.001, 600)).toBeCloseTo(-0.001, 5);
    const near = sheetDragOffset(-30, 600);
    const far = sheetDragOffset(-60, 600);
    expect(near).toBeGreaterThan(-30);
    expect(far).toBeLessThan(near);
    expect(near - far).toBeLessThan(-near);
    expect(sheetDragOffset(-100000, 600)).toBeGreaterThan(-90);
    expect(Number.isFinite(sheetDragOffset(-30, 0))).toBe(true);
  });

  test("re-grabbing a returning sheet preserves its position", () => {
    for (const distance of [-600, -60, -1, 0, 100]) {
      const offset = sheetDragOffset(distance, 600);
      const recovered = sheetDragDistance(offset, 600);
      expect(recovered).toBeCloseTo(distance, 6);
      expect(sheetDragOffset(recovered, 600)).toBeCloseTo(offset, 6);
    }
  });
});
