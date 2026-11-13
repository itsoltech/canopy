import { expect, test } from "bun:test";
import { join } from "node:path";
import { Schema } from "effect";
import { tempDir } from "@canopy/testing";

const directory = tempDir("canopy-diagnostics-report-");
let sequence = 0;
const phases = ["idle", "steady", "slow_reader", "governor", "log_export", "trace_worker"];
const resource = { cpuPercent: 1, rss: 1048576, heap: 1048576 };

const reportSchema = Schema.fromJsonString(
  Schema.Struct({
    accepted: Schema.Array(Schema.Struct({ pair: Schema.Number })),
    medians: Schema.Array(
      Schema.Struct({ phase: Schema.String, metric: Schema.String, all: Schema.NullOr(Schema.Number) }),
    ),
  }),
);

function measurements(pair: number, selected = phases) {
  return (pair % 2 ? [false, true] : [true, false]).flatMap((on) =>
    selected.map((phase) => ({
      ...resource,
      cpuPercent: on ? 2 : 1,
      phase,
      series: pair,
      attempt: 1,
      on,
      rpcP95Ms: phase === "idle" ? null : on ? 3 : 2,
      pgCpuPercent: 0,
      worker: resource,
    })),
  );
}

function accepted(pair: number) {
  return {
    phase: "pair_end",
    pair,
    attempt: 1,
    accepted: true,
    swapOutBytes: 0,
    peakSwapOutKiBPerSec: 0,
    violations: [],
  };
}

async function runReport(rows: readonly object[]) {
  const file = join(directory, `${++sequence}.jsonl`);
  await Bun.write(file, rows.map((row) => JSON.stringify(row)).join("\n"));

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "diagnostics-paired-report.ts"), file], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

test("reports the stage's recorded phases while preserving complete strict AB/BA pairs", async () => {
  const result = await runReport([...measurements(1), accepted(1), ...measurements(2), accepted(2)]);
  expect(result.code).toBe(0);
  const report = Schema.decodeUnknownSync(reportSchema)(result.stdout);
  expect(report.accepted.map((pair) => pair.pair)).toEqual([1, 2]);
  expect(report.medians.filter((row) => row.metric === "gateway.cpuPp")).toEqual(
    phases.map((phase) => ({ phase, metric: "gateway.cpuPp", all: 1 })),
  );
  const earlierStage = await runReport([...measurements(1, ["idle", "steady", "write_failure"]), accepted(1)]);
  expect(earlierStage.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(reportSchema)(earlierStage.stdout).medians.some((row) => row.phase === "trace_worker"),
  ).toBe(false);
});

test("an accepted pair missing one phase member cannot silently enter the medians", async () => {
  const incomplete = measurements(1).filter((row) => !(row.on && row.phase === "trace_worker"));
  const result = await runReport([...incomplete, accepted(1), ...measurements(2), accepted(2)]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("exactly one A and B per phase");
});

test("accepted pair metadata cannot hide a reversed AB/BA order", async () => {
  const result = await runReport([...measurements(1).toReversed(), accepted(1)]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("violates strict AB/BA order");
});
