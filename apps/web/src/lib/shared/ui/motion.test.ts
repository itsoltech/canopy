/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { duration, toMs } from "./motion.ts";

describe("motion tokens in script", () => {
  test("reads CSS times in either unit (the minifier writes 250ms as .25s)", () => {
    expect(toMs("250ms")).toBe(250);
    expect(toMs(".25s")).toBe(250);
    expect(toMs(" 0.15s")).toBe(150);
    expect(toMs("0s")).toBe(0);
  });

  test("falls back to the scale without a document (server)", () => {
    expect(duration("fast")).toBe(250);
    expect(duration("quick")).toBe(150);
  });
});
