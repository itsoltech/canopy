import { describe, expect, test } from "bun:test";
import { citePosition } from "./cite-position.ts";

const size = { width: 76, height: 28 };
const room = { top: 56, bottom: 700, width: 1440 };
const line = (top: number, left = 400, right = 760) => ({ left, right, top, bottom: top + 24, height: 24 });

describe("citePosition: the Cite button next to a selection, clear of the composer", () => {
  test("with a mouse: below the selection's last line, its right edge at the selection's end", () => {
    expect(citePosition(line(300), size, room, { backward: false, touch: false })).toEqual({ x: 760 - 76, y: 300 + 24 + 6 });
  });

  test("a selection made backwards: above its first line, from its start", () => {
    expect(citePosition(line(300), size, room, { backward: true, touch: false })).toEqual({ x: 400, y: 300 - 6 - 28 });
  });

  test("right above the composer it flips above the line instead of covering the composer", () => {
    const at = citePosition(line(670), size, room, { backward: false, touch: false })!;
    expect(at.y + size.height).toBeLessThanOrEqual(670);
  });

  test("on touch screens: centred below the handles", () => {
    expect(citePosition(line(300, 100, 300), size, { ...room, width: 390 }, { backward: false, touch: true })).toEqual({ x: 300 - 38, y: 300 + 24 + 28 });
  });

  test("no button while the selection's end is under the top bar or the composer", () => {
    expect(citePosition(line(10), size, room, { backward: false, touch: false })).toBeUndefined();
    expect(citePosition(line(720), size, room, { backward: false, touch: false })).toBeUndefined();
    expect(citePosition(undefined, size, room, { backward: false, touch: false })).toBeUndefined();
  });
});
