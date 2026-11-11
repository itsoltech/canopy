import { expect, test } from "bun:test";
import { SwapGate } from "./diagnostics-swap.ts";

test("stage 2 admits old-page swap-in but rejects three consecutive 4 MiB/s samples", () => {
  const rejected: string[] = [];
  const gate = new SwapGate((kind) => rejected.push(kind), true);

  for (const input of [128, 1024, 4095, 8192, 4096, 0, 4096, 4096]) gate.sample(input, 0);
  expect(rejected).toEqual([]);
  expect(gate.longestInput).toBe(2);
  expect(gate.peakInputKiB).toBe(8192);
  gate.sample(4096, 0);
  expect(rejected).toEqual(["swap_in_sustained"]);
});

test("swap-out rate and cumulative byte limits stay inclusive in both stages", () => {
  for (const stage2 of [false, true]) {
    const rejected: string[] = [];
    const gate = new SwapGate((kind) => rejected.push(kind), stage2);
    gate.sample(0, 127);
    gate.cumulative(1024 * 1024 - 1);
    expect(rejected).toEqual([]);
    gate.sample(0, 128);
    gate.cumulative(1024 * 1024);
    expect(rejected).toEqual(["swap_out_rate", "swap_out_total_bytes"]);
  }
});

test("stage 1 retains its original immediate and sustained swap-in gates", () => {
  const rejected: string[] = [];
  const gate = new SwapGate((kind) => rejected.push(kind));
  gate.sample(1024, 0);
  gate.sample(128, 0);
  gate.sample(128, 0);
  expect(rejected).toEqual(["swap_in_rate", "swap_in_sustained"]);
});
