import { expect, test } from "bun:test";
import { Schema } from "effect";

const Sample = Schema.Struct({
  cycle: Schema.Number,
  heap: Schema.Number,
  measures: Schema.Number,
  histograms: Schema.Number,
  objects: Schema.Number,
  used: Schema.Number,
  internal: Schema.Number,
  database: Schema.Number,
  dropped: Schema.Number,
  active: Schema.Number,
  queued: Schema.Number,
  slots: Schema.Number,
});
const decode = Schema.decodeSync(Schema.fromJsonString(Sample));
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const MiB = 1024 * 1024;

test("governor and SQL series plateau after GC across saturated queues and rolling histories", async () => {
  const child = Bun.spawn([process.execPath, "tests/integration/support/diagnostics-memory.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  const samples = output.trim().split("\n").map((line) => decode(line));
  expect(samples).toHaveLength(21);
  const baseline = samples[0]!;
  expect(baseline.measures).toBeGreaterThan(0);
  expect(baseline.histograms).toBeGreaterThan(0);
  const steady = samples.slice(1);
  // Fixed limits: no timing gate; the child has no test runner or prior suite's heap.
  expect(Math.max(...steady.map((sample) => sample.heap)) - baseline.heap).toBeLessThanOrEqual(4 * MiB);
  expect(
    median(steady.slice(-5).map((sample) => sample.heap)) - median(steady.slice(0, 5).map((sample) => sample.heap)),
  ).toBeLessThanOrEqual(MiB);
  expect(steady.at(-1)!.dropped).toBeGreaterThan(baseline.dropped);

  for (const sample of samples) {
    expect(sample.used).toBeLessThanOrEqual(6 * MiB);
    expect(sample.internal).toBeLessThanOrEqual(MiB);
    expect(sample.database).toBeLessThanOrEqual(MiB / 2);
    expect(sample.active).toBe(0);
    expect(sample.queued).toBe(0);
    expect(sample.slots).toBeLessThanOrEqual(61);
    expect(sample.measures - baseline.measures).toBeLessThanOrEqual(256);
    expect(sample.histograms - baseline.histograms).toBeLessThanOrEqual(256);
  }
  console.info(
    "diagnostics-memory",
    JSON.stringify({ baseline, last: steady.at(-1), heapGrowthMiB: (steady.at(-1)!.heap - baseline.heap) / MiB }),
  );
}, 120_000);
