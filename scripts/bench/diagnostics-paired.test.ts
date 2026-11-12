import { expect, test } from "bun:test";
import { median, pairedSummary } from "./diagnostics-paired.ts";

test("MAD sensitivity flags only strict outliers with concurrent high host swap-out and removes whole pairs", () => {
  const rows = [0, 1, 2, 10].map((delta, index) => ({ pair: index + 1, phase: "steady", metric: "cpu", delta }));
  rows.push(...[10, 20, 30, 40].map((delta, index) => ({ pair: index + 1, phase: "idle", metric: "rss", delta })));
  const swaps = rows.slice(0, 4).map((row) => ({ pair: row.pair, peakSwapOutKiBPerSec: 4096 }));
  expect(pairedSummary(rows, swaps).flaggedPairs).toEqual([]);
  swaps[3]!.peakSwapOutKiBPerSec++;
  const result = pairedSummary(rows, swaps);
  expect(result.flaggedPairs).toEqual([4]);
  expect(result.flags).toEqual([{ ...rows[3]!, median: 1.5, mad: 1, peakSwapOutKiBPerSec: 4097 }]);
  expect(result.medians).toEqual([
    { phase: "steady", metric: "cpu", n: 4, all: 1.5, unflaggedN: 3, unflagged: 1 },
    { phase: "idle", metric: "rss", n: 4, all: 25, unflaggedN: 3, unflagged: 20 },
  ]);
});

test("zero MAD flags nonzero deviations, empty sensitivity stays null, missing counters fail closed", () => {
  expect(median([])).toBeNull();
  const rows = [1, 1, 1, 2].map((delta, index) => ({ pair: index + 1, phase: "steady", metric: "cpu", delta }));
  const swaps = rows.map((row) => ({ pair: row.pair, peakSwapOutKiBPerSec: 8192 }));
  expect(pairedSummary(rows, swaps).flaggedPairs).toEqual([4]);
  expect(() => pairedSummary(rows, [])).toThrow("Missing accepted pair swap counters");
});
