import { expect, test } from "bun:test";
import { pairResult } from "./diagnostics-series-result.ts";
import { latencyNoise } from "./diagnostics-noise.ts";

test("fresh-member aggregation rejects partial pairs and preserves all noise violations", () => {
  const member = {
    phase: "member_end" as const,
    pair: 1,
    attempt: 1,
    accepted: true,
    maxLoad: 2,
    samples: 10,
    swapInBytes: 4096,
    swapOutBytes: 8192,
    peakSwapInKiBPerSec: 4,
    peakSwapOutKiBPerSec: 8,
    longestSwapInThresholdRun: 0,
    violations: [],
  };

  expect(pairResult(1, 1, [member]).accepted).toBe(false);
  const valid = pairResult(1, 1, [member, member]);
  expect(valid.accepted).toBe(true);
  expect(valid.samples).toBe(20);
  expect(valid.swapOutBytes).toBe(16384);
  expect(valid.peakSwapOutKiBPerSec).toBe(8);
  expect(
    pairResult(1, 1, [member, { ...member, accepted: false, violations: [{ kind: "scope_swap_current", value: "1" }] }])
      .accepted,
  ).toBe(false);
  expect(() => pairResult(2, 1, [member, member])).toThrow("Mismatched member");
});

test("latency comparison uses an absolute A/A envelope without subtracting noise from measured costs", () => {
  const row = (pair: number, delta: number) => ({ pair, phase: "steady", metric: "rpc.p95Ms", delta });
  const controls = [row(1, -0.6), row(2, 0.2)];
  const result = latencyNoise([row(1, 0.6), row(2, 0.8)], controls)[0]!;
  expect(result.controlN).toBe(2);
  expect(result.floorMs).toBe(0.6);
  expect(result.deltaMs).toBeCloseTo(0.7);
  expect(result.withinNoiseOrTarget).toBe(false);
  expect(latencyNoise([row(1, 0.25)], [row(1, 0.1), row(2, 0.05)])[0]!.withinNoiseOrTarget).toBe(true);
  expect(() => latencyNoise([row(1, 0.1)], [row(1, 0.1)])).toThrow("Two accepted A/A");
});
