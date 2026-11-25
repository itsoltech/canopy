import { expect, test } from "bun:test";
import { activityNotchGeometry } from "../src/activity-notch-geometry.ts";

test("macOS uses the simulated gap at the display edge and follows the visible menu band's height", () => {
  const bounds = { x: -1600, y: -56, width: 1600, height: 900 };
  const workArea = { x: -1560, y: -32, width: 1560, height: 826 };

  expect(activityNotchGeometry({ bounds, workArea }, 0, {})).toEqual({
    bounds: { x: -948, y: -56, width: 296, height: 24 },
    headerHeight: 24,
  });
  expect(activityNotchGeometry({ bounds, workArea: bounds }, 0, {})).toEqual({
    bounds: { x: -948, y: -56, width: 296, height: 32 },
    headerHeight: 32,
  });
});

test("macOS centers the wings around a scaled physical cutout and caps the expanded rows", () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  const display = { bounds, workArea: { ...bounds, y: 39, height: 893 } };
  const cutout = { center: 757.5, width: 212.25, height: 37.5 };

  expect(activityNotchGeometry(display, 0, { cutout })).toEqual({
    bounds: { x: 602, y: 0, width: 311, height: 39 },
    headerHeight: 39,
  });
  expect(activityNotchGeometry(display, 1, { cutout })).toEqual({
    bounds: { x: 510, y: 0, width: 496, height: 79 },
    headerHeight: 39,
  });
  expect(activityNotchGeometry(display, 24, { cutout })).toEqual({
    bounds: { x: 510, y: 0, width: 496, height: 271 },
    headerHeight: 39,
  });
  expect(activityNotchGeometry({ bounds, workArea: bounds }, 0, { cutout }).headerHeight).toBe(38);
});

test("Windows attaches to the display edge or the occupied top taskbar boundary", () => {
  const bounds = { x: 320, y: 128, width: 1280, height: 960 };
  const bottomTaskbar = { ...bounds, height: 912 };
  const topTaskbar = { ...bottomTaskbar, y: 176 };

  expect(activityNotchGeometry({ bounds, workArea: bottomTaskbar }, 0)).toEqual({
    bounds: { x: 812, y: 128, width: 296, height: 32 },
    headerHeight: 32,
  });
  expect(activityNotchGeometry({ bounds, workArea: topTaskbar }, 2)).toEqual({
    bounds: { x: 712, y: 176, width: 496, height: 104 },
    headerHeight: 32,
  });
});

test("Windows clamps a centered panel to a narrow work area", () => {
  const bounds = { x: 0, y: 0, width: 480, height: 240 };
  const workArea = { x: 60, y: 0, width: 420, height: 240 };

  expect(activityNotchGeometry({ bounds, workArea }, 9)).toEqual({
    bounds: { x: 60, y: 0, width: 420, height: 240 },
    headerHeight: 32,
  });
});
