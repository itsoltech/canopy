import { describe, expect, test } from "bun:test";
import { maxSidebarWidth, SIDEBAR_WIDTH, sidebarWidthFor, storedSidebarWidth } from "./sidebar.ts";

describe("sidebar width", () => {
  test("the gateway keeps 0 as the default and holds other widths within min…max", () => {
    expect(storedSidebarWidth(0)).toBe(0);
    expect(storedSidebarWidth(Number.NaN)).toBe(0);
    expect(storedSidebarWidth(1)).toBe(SIDEBAR_WIDTH.min);
    expect(storedSidebarWidth(300.6)).toBe(301);
    expect(storedSidebarWidth(4_000_000_000)).toBe(SIDEBAR_WIDTH.max);
  });

  test("the window caps the width at 45% (never under the minimum)", () => {
    expect(maxSidebarWidth(1440)).toBe(560);
    expect(maxSidebarWidth(1024)).toBe(460);
    expect(maxSidebarWidth(300)).toBe(SIDEBAR_WIDTH.min);
  });

  test("a saved width is shown within the window's range; 0 shows the default", () => {
    expect(sidebarWidthFor(0, 1440)).toBe(SIDEBAR_WIDTH.default);
    expect(sidebarWidthFor(540, 1440)).toBe(540);
    expect(sidebarWidthFor(540, 1024)).toBe(460);
    expect(sidebarWidthFor(100, 1440)).toBe(SIDEBAR_WIDTH.min);
  });
});
