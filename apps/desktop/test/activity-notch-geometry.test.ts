import { expect, test } from "bun:test";
import { activityNotchFrame, draggedPlacement } from "../src/activity-notch-frame.ts";
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
    bounds: { x: 510, y: 0, width: 496, height: 119 },
    headerHeight: 39,
  });
  expect(activityNotchGeometry(display, 24, { cutout })).toEqual({
    bounds: { x: 510, y: 0, width: 496, height: 407 },
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
    bounds: { x: 712, y: 176, width: 496, height: 184 },
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

const workArea = { x: 0, y: 0, width: 1280, height: 752 };

test("an edge tab's window grows only down from a corner that the rows do not move", () => {
  const right = { mode: "edge", edge: "right", offset: 0.25 } as const;

  expect(activityNotchFrame(workArea, right, 0, 0)).toMatchObject({
    window: { x: 800, y: 136, width: 480, height: 104 },
    shape: { x: 1248, y: 144, width: 32, height: 88 },
  });
  expect(activityNotchFrame(workArea, right, 3, 3)).toMatchObject({
    window: { x: 800, y: 136, width: 480, height: 272 },
    shape: { x: 800, y: 144, width: 480, height: 256 },
  });

  // Near the bottom the panel rises above the tab, so the window starts high enough for every row.
  const low = { ...right, offset: 0.95 };
  expect(activityNotchFrame(workArea, low, 0, 0).window).toEqual({ x: 800, y: 336, width: 480, height: 416 });
  expect(activityNotchFrame(workArea, low, 1, 1)).toMatchObject({
    window: { x: 800, y: 336, width: 480, height: 416 },
    shape: { x: 800, y: 632, width: 480, height: 112 },
  });
});

test("a panel that opens upward keeps one window for any number of rows", () => {
  const bottom = { mode: "edge", edge: "bottom", offset: 0.85 } as const;
  const window = { x: 784, y: 352, width: 496, height: 400 };

  expect(activityNotchFrame(workArea, bottom, 0, 0)).toMatchObject({
    window,
    header: "end",
    shape: { x: 1044, y: 720, width: 88, height: 32 },
  });
  expect(activityNotchFrame(workArea, bottom, 2, 2)).toMatchObject({
    window,
    shape: { x: 792, y: 568, width: 480, height: 184 },
  });
});

test("a dragged tab slides along its edge, snaps to the center and docks to an edge that is clearly closer", () => {
  const right = { mode: "edge", edge: "right", offset: 0.25 } as const;
  const tab = { x: 1248, y: 144, width: 32, height: 88 };

  expect(draggedPlacement(workArea, right, tab, { x: 0, y: 300 }, 7)).toEqual({
    mode: "edge",
    edge: "right",
    offset: 488 / 752,
    display: 7,
  });
  expect(draggedPlacement(workArea, right, tab, { x: 0, y: 200 }, 7)).toMatchObject({ edge: "right", offset: 0.5 });
  expect(draggedPlacement(workArea, right, tab, { x: -1240, y: 0 }, 7)).toMatchObject({ edge: "left", offset: 0.25 });
  // In the corner the top edge is closer, but not by enough to take the tab.
  expect(draggedPlacement(workArea, right, tab, { x: -2, y: -178 }, 7)).toMatchObject({ edge: "right" });

  const pill = { x: 500, y: 300, width: 104, height: 32 };
  const floating = { mode: "floating", x: 0.5, y: 0.5 } as const;
  expect(draggedPlacement(workArea, floating, pill, { x: 80, y: -400 }, 7)).toEqual({
    mode: "floating",
    x: 0.5,
    y: 0,
    display: 7,
  });
});
