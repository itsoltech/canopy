import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram, Measure, percentiles, MAX_COUNT } from "@canopy/domain/diagnostics";

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

test("sparse percentile merging preserves exact ranks, overflow bits and uint64 saturation", () => {
  const first = create(ui.DiagnosticsHistogramSchema, {
    indices: [129, 1, 100],
    counts: [3n, 96n, 1n],
    min: 0.001,
    max: 10_000_000,
    sum: 30_000_000,
  });

  const value = percentiles([first]);
  expect(value.samples).toBe(100n);
  expect(value.p50).toBe(0.001);
  expect(value.p95).toBe(0.001);
  expect(value.overflow).toBe(true);
  expect(value.overflowQuantiles).toBe(4);
  expect(value.sum).toBe(first.sum);

  const saturated = percentiles([
    create(ui.DiagnosticsHistogramSchema, { indices: [1], counts: [MAX_COUNT - 1n], min: 0.001, max: 0.001 }),
    create(ui.DiagnosticsHistogramSchema, { indices: [1, 129], counts: [4n, 1n], min: 0.001, max: 1e8 }),
  ]);

  expect(saturated.samples).toBe(MAX_COUNT);
  expect(saturated.p99).toBe(0.001);
  expect(saturated.overflow).toBe(true);
  expect(saturated.overflowQuantiles).toBe(0);
});

test("live counters merge and persist exactly across the safe integer and uint64 limits", () => {
  const measure = new Measure();
  measure.counter(Number.MAX_SAFE_INTEGER, false, 1);
  measure.counter(2, true, 2);
  measure.timing(125, true, 3);
  expect(measure.events).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 3n);
  expect(measure.errors).toBe(3n);

  const restored = new Measure();
  restored.merge(
    fromBinary(
      ui.DiagnosticsMeasureAggregateSchema,
      toBinary(ui.DiagnosticsMeasureAggregateSchema, measure.snapshot(1)),
    ),
  );
  restored.timing(250, false, 4);
  expect(restored.events).toBe(measure.events + 1n);
  expect(restored.errors).toBe(measure.errors);
  const before = restored.histogram!.snapshot();
  expect(percentiles([restored.histogram!])).toEqual(percentiles([before]));
  expect(restored.histogram!.snapshot()).toEqual(before);

  const large = new Histogram(false, true);
  large.merge(create(ui.DiagnosticsHistogramSchema, { indices: [1], counts: [MAX_COUNT - 1n], max: 0.001 }));
  large.record(0.001);
  large.record(0.001);
  expect(large.snapshot().counts).toEqual([MAX_COUNT]);
  expect(large.incomplete).toBe(true);
});
