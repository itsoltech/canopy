import { expect, test } from "bun:test";
import { restoredBounds, type DisplayArea } from "../src/window-bounds.ts";

const limits = { minWidth: 760, minHeight: 560 };
const laptop: DisplayArea = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 920 } };
const leftMonitor: DisplayArea = { id: 2, workArea: { x: -2560, y: -300, width: 2560, height: 1440 } };

test("bounds inside a display, including a left-side monitor with negative coordinates, stay as saved", () => {
  const onLaptop = { x: 100, y: 60, width: 1280, height: 850 };
  const onLeft = { x: -2400, y: -200, width: 1600, height: 1000 };

  expect(restoredBounds(onLaptop, 1, [laptop, leftMonitor], limits)).toEqual(onLaptop);
  expect(restoredBounds(onLeft, 2, [laptop, leftMonitor], limits)).toEqual(onLeft);
  // The display id only picks a target for bounds that need fixing.
  expect(restoredBounds(onLeft, 99, [laptop, leftMonitor], limits)).toEqual(onLeft);
});

test("a removed monitor centres the window on the closest remaining display", () => {
  const onLeft = { x: -2400, y: -200, width: 1600, height: 1000 };

  expect(restoredBounds(onLeft, 2, [laptop], limits)).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  expect(restoredBounds({ ...onLeft, width: 1000, height: 700 }, 2, [laptop], limits)).toEqual({
    x: 256,
    y: 135,
    width: 1000,
    height: 700,
  });
});

test("a smaller resolution shrinks the window to the work area and keeps it on screen", () => {
  const shrunk: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } };

  expect(restoredBounds({ x: 600, y: 300, width: 1400, height: 900 }, 1, [shrunk], limits)).toEqual({
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
  });
  expect(restoredBounds({ x: 900, y: 400, width: 800, height: 600 }, 1, [shrunk], limits)).toEqual({
    x: 480,
    y: 120,
    width: 800,
    height: 600,
  });
});

test("a window partly off-screen is pulled back onto the display that shows most of it", () => {
  expect(
    restoredBounds({ x: -300, y: 100, width: 1000, height: 700 }, undefined, [laptop, leftMonitor], limits),
  ).toEqual({ x: 0, y: 100, width: 1000, height: 700 });
  expect(
    restoredBounds({ x: -900, y: 100, width: 1000, height: 700 }, undefined, [laptop, leftMonitor], limits),
  ).toEqual({ x: -1000, y: 100, width: 1000, height: 700 });
});

test("minimum sizes win over saved sizes and over a work area that is too small", () => {
  expect(restoredBounds({ x: 10, y: 40, width: 200, height: 100 }, 1, [laptop], limits)).toEqual({
    x: 10,
    y: 40,
    width: 760,
    height: 560,
  });

  const tiny: DisplayArea = { id: 3, workArea: { x: 0, y: 0, width: 640, height: 480 } };

  // The top-left corner stays visible so the title bar can still be grabbed.
  expect(restoredBounds({ x: 50, y: 50, width: 1000, height: 800 }, 3, [tiny], limits)).toEqual({
    x: 0,
    y: 0,
    width: 760,
    height: 560,
  });
});

test("no displays leaves the default centred placement", () => {
  expect(restoredBounds({ x: 0, y: 0, width: 1000, height: 700 }, 1, [], limits)).toBeUndefined();
});
