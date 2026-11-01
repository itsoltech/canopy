/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { SizeIndex, type SizedRow } from "./size-index.ts";

const rows = (count: number, group = "row", prefix = "r"): SizedRow[] => Array.from({ length: count }, (_, i) => ({ key: `${prefix}${i}`, group }));

describe("SizeIndex", () => {
  test("estimates unmeasured rows by the fallback, then by the group average", () => {
    const index = new SizeIndex(() => 10);
    index.setRows(rows(4));
    expect(index.total).toBe(40);
    index.measure("r0", "row", 30);
    // r0 measured, the other three estimated by the average (30).
    expect(index.total).toBe(120);
    index.measure("r1", "row", 50);
    expect(index.offset(2)).toBe(80);
    expect(index.total).toBe(80 + 2 * 40);
  });

  test("finds the rows of a window and the tail", () => {
    const index = new SizeIndex(() => 10);
    index.setRows(rows(100));
    expect(index.indexAt(0)).toBe(0);
    expect(index.indexAt(15)).toBe(1);
    expect(index.indexAt(10_000)).toBe(99);
    expect(index.range(25, 55)).toEqual([2, 6]);
    expect(index.range(30, 50)).toEqual([3, 5]);
    expect(index.tail(35)).toEqual([96, 100]);
  });

  test("keeps measurements by key when rows are prepended", () => {
    const index = new SizeIndex(() => 10);
    index.setRows(rows(3));
    index.measure("r2", "row", 100);
    index.setRows([...rows(2, "row", "older"), ...rows(3)]);
    expect(index.size(4)).toBe(100);
    expect(index.isMeasured("older0")).toBe(false);
  });

  test("an empty list has no rows to show", () => {
    const index = new SizeIndex(() => 10);
    expect(index.range(0, 100)).toEqual([0, 0]);
    expect(index.tail(100)).toEqual([0, 0]);
    expect(index.total).toBe(0);
  });
});
