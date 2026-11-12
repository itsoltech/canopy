import { expect, test } from "bun:test";
import { Schema } from "effect";

const Sample = Schema.Struct({
  cycle: Schema.Number,
  phase: Schema.String,
  heap: Schema.Number,
  objects: Schema.Number,
});

const decode = Schema.decodeSync(Schema.fromJsonString(Sample));

test("stopped tracing retains only bounded export data and releases it at TTL across repeated full rings", async () => {
  const child = Bun.spawn([process.execPath, "tests/integration/support/diagnostics-trace-memory.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);

  const samples = output
    .trim()
    .split("\n")
    .map((line) => decode(line));

  expect(samples).toHaveLength(25);
  const baseline = samples[0]!;

  for (const sample of samples.slice(1)) expect(sample.heap - baseline.heap).toBeLessThan(2 * 1024 * 1024);
  const purged = samples.filter((sample) => sample.phase === "purged");
  expect(purged.at(-1)!.heap - purged[0]!.heap).toBeLessThan(1024 * 1024);
  console.info(
    "diagnostics-trace-memory",
    JSON.stringify({ baseline, stopped: samples.at(-2), purged: samples.at(-1) }),
  );
}, 30_000);
