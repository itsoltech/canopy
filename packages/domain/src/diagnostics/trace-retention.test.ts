import { expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { DiagnosticsTrace, TRACE_LIMITS, LEGACY_TRACE_SAMPLES } from "./tracing.ts";

test("a 237 second capture retains 2112 sampled operations without overwriting its start", () => {
  let now = 0;

  const trace = new DiagnosticsTrace(
    () => now,
    () => now,
  );

  const lease = crypto.randomUUID();

  expect(trace.start(lease, "gateway", 5)).toBe(true);

  // Frequency from the reported capped capture, with numeric synthetic data only.
  for (let sample = 0; sample < 2112; sample++) {
    now = Math.floor((sample * 237_000) / 2112);

    for (let call = 0; call < TRACE_LIMITS.stride; call++) trace.record("database", 1001, 0.1);
  }

  const result = trace.export(lease)!;
  const legacy = trace.export(lease, LEGACY_TRACE_SAMPLES)!;
  expect(legacy.spans).toHaveLength(2000);
  expect(legacy.droppedSamples).toBe(112n);
  expect(legacy.spans[0]!.sampledAtMs).toBeGreaterThan(0n);
  expect(result.spans).toHaveLength(2112);
  expect(result.spans[0]?.sampledAtMs).toBe(0n);
  expect(result.droppedSamples).toBe(0n);
  expect(toBinary(ui.DiagnosticsTraceExportSchema, result).length).toBeLessThan(TRACE_LIMITS.bytes);
  trace.stop(lease);
  now += 600_001;
  expect(trace.export(lease)).toBeUndefined();
});
