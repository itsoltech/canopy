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

test("swap-disabled stages record host swap-out without rejecting its rate or total", () => {
  const rejected: string[] = [];
  const gate = new SwapGate((kind) => rejected.push(kind), true);
  gate.sample(0, 4095);
  gate.cumulative(128 * 1024 * 1024);
  expect(rejected).toEqual([]);
  gate.sample(0, 4096);
  gate.sample(0, 19532);
  expect(rejected).toEqual([]);
  expect(gate.peakOutputKiB).toBe(19532);
});

test("stage 1 retains inclusive swap-out rate and cumulative limits", () => {
  const rejected: string[] = [];
  const gate = new SwapGate((kind) => rejected.push(kind));
  gate.sample(0, 127);
  gate.cumulative(1024 * 1024 - 1);
  expect(rejected).toEqual([]);
  gate.sample(0, 128);
  gate.cumulative(1024 * 1024);
  expect(rejected).toEqual(["swap_out_rate", "swap_out_total_bytes"]);
});

test("stage 1 retains its original immediate and sustained swap-in gates", () => {
  const rejected: string[] = [];
  const gate = new SwapGate((kind) => rejected.push(kind));
  gate.sample(1024, 0);
  gate.sample(128, 0);
  gate.sample(128, 0);
  expect(rejected).toEqual(["swap_in_rate", "swap_in_sustained"]);
});
