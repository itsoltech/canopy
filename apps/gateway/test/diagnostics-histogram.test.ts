import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram, percentiles } from "@canopy/domain/diagnostics";

test("quantized percentiles stay within observed extrema, including underflow and overflow", () => {
  for (const [sizes, samples] of [
    [false, [125, 125, 125]],
    [false, [0, 0.00001, 0.0001]],
    [false, [8_000_000, 9_000_000, 10_000_000]],
    [true, [0, 1, 3]],
    [true, [2 ** 32, 2 ** 33]],
  ] as const) {
    const histogram = new Histogram(sizes);

    for (const sample of samples) histogram.record(sample);
    const value = percentiles([histogram.snapshot()], sizes);

    for (const percentile of [value.p50, value.p95, value.p99]) {
      expect(percentile).toBeGreaterThanOrEqual(Math.min(...samples));
      expect(percentile).toBeLessThanOrEqual(Math.max(...samples));
    }

    expect(value.max).toBe(Math.max(...samples));
    expect(value.p50).toBeLessThanOrEqual(value.p95);
    expect(value.p95).toBeLessThanOrEqual(value.p99);
  }
});

test("merged and persisted histograms retain extrema without inventing a minimum for old data", () => {
  const lower = new Histogram();
  lower.record(125);
  const higher = new Histogram();
  higher.record(250);
  const merged = new Histogram();
  merged.merge(lower);
  merged.merge(higher.snapshot());
  merged.merge(new Histogram().snapshot());

  const restored = fromBinary(
    ui.DiagnosticsHistogramSchema,
    toBinary(ui.DiagnosticsHistogramSchema, merged.snapshot()),
  );

  expect(restored.min).toBe(125);
  expect(restored.max).toBe(250);
  expect(percentiles([restored]).p99).toBe(250);
  expect(percentiles([lower.snapshot()]).p99).toBe(125);

  const old = create(ui.DiagnosticsHistogramSchema, { indices: [1], counts: [1n], sum: 0.001, max: 0.001 });
  const mixed = new Histogram();
  mixed.merge(restored);
  mixed.merge(old);
  expect(mixed.snapshot().min).toBe(0);
  expect(percentiles([old]).p99).toBeLessThanOrEqual(old.max);
  expect(percentiles([]).samples).toBe(0n);
});
