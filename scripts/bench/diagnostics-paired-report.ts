import { Schema } from "effect";
import { pairedSummary, type PairedDelta } from "./diagnostics-paired.ts";
import { latencyNoise } from "./diagnostics-noise.ts";

const Phase = Schema.Literals([
  "idle",
  "steady",
  "reconnect",
  "slow_reader",
  "write_failure",
  "pool_contention",
  "governor",
]);

const Resource = Schema.Struct({ cpuPercent: Schema.Number, rss: Schema.Number, heap: Schema.Number });

const Measurement = Schema.Struct({
  ...Resource.fields,
  phase: Phase,
  series: Schema.Number,
  attempt: Schema.Number,
  on: Schema.Boolean,
  slotOn: Schema.optional(Schema.Boolean),
  rpcP95Ms: Schema.NullOr(Schema.Number),
  pgCpuPercent: Schema.Number,
  worker: Resource,
  historyReadP95Ms: Schema.optional(Schema.NullOr(Schema.Number)),
});

const PairEnd = Schema.Struct({
  pair: Schema.Number,
  attempt: Schema.Number,
  accepted: Schema.Boolean,
  swapOutBytes: Schema.Number,
  peakSwapOutKiBPerSec: Schema.Number,
  violations: Schema.Array(Schema.Struct({ kind: Schema.String, value: Schema.String })),
});

const file = Bun.argv[2];

if (!file) throw new Error("Usage: bun scripts/bench/diagnostics-paired-report.ts results.jsonl");

const rows: (typeof Measurement.Type)[] = [];
const ends: (typeof PairEnd.Type)[] = [];

for (const line of (await Bun.file(file).text()).split("\n")) {
  if (!line.trim()) continue;

  const envelope = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ phase: Schema.optional(Schema.String) })),
  )(line);

  if (envelope.phase === "pair_end") ends.push(Schema.decodeUnknownSync(Schema.fromJsonString(PairEnd))(line));
  else if (Schema.is(Phase)(envelope.phase))
    rows.push(Schema.decodeUnknownSync(Schema.fromJsonString(Measurement))(line));
}

const accepted = ends.filter((row) => row.accepted);
const deltas: PairedDelta[] = [];

for (const end of accepted) {
  const measurements = rows.filter((row) => row.series === end.pair && row.attempt === end.attempt);

  for (const phase of Phase.literals) {
    const sides = measurements.filter((row) => row.phase === phase);
    const a = sides.find((row) => !(row.slotOn ?? row.on));
    const b = sides.find((row) => row.slotOn ?? row.on);

    if (sides.length !== 2 || !a || !b) throw new Error("Accepted pair lacks exactly one A and B per phase");

    if ((sides[0]!.slotOn ?? sides[0]!.on) !== (end.pair % 2 === 0))
      throw new Error("Accepted pair violates strict AB/BA order");
    const add = (metric: string, delta: number) => deltas.push({ pair: end.pair, phase, metric, delta });
    add("gateway.cpuPp", b.cpuPercent - a.cpuPercent);
    add("worker.cpuPp", b.worker.cpuPercent - a.worker.cpuPercent);
    add("postgres.cpuPp", b.pgCpuPercent - a.pgCpuPercent);
    add(
      "total.cpuPp",
      b.cpuPercent + b.worker.cpuPercent + b.pgCpuPercent - a.cpuPercent - a.worker.cpuPercent - a.pgCpuPercent,
    );

    for (const key of ["rss", "heap"] as const) {
      add(`gateway.${key}MiB`, (b[key] - a[key]) / 1048576);
      add(`worker.${key}MiB`, (b.worker[key] - a.worker[key]) / 1048576);
    }

    if (a.rpcP95Ms !== null && b.rpcP95Ms !== null) {
      add("rpc.p95Ms", b.rpcP95Ms - a.rpcP95Ms);

      if (a.rpcP95Ms > 0) add("rpc.p95Percent", ((b.rpcP95Ms - a.rpcP95Ms) / a.rpcP95Ms) * 100);
    }

    if (a.historyReadP95Ms != null && b.historyReadP95Ms != null)
      add("history.p95Ms", b.historyReadP95Ms - a.historyReadP95Ms);
  }
}

const controlPath = Bun.argv[3];

const control = controlPath
  ? Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          deltas: Schema.Array(
            Schema.Struct({ pair: Schema.Number, phase: Schema.String, metric: Schema.String, delta: Schema.Number }),
          ),
        }),
      ),
    )(await Bun.file(controlPath).text())
  : undefined;

const summary = pairedSummary(deltas, accepted);

console.info(
  JSON.stringify(
    {
      accepted,
      rejected: ends.filter((row) => !row.accepted),
      deltas,
      ...summary,
      latencyNoise: control ? latencyNoise(deltas, control.deltas) : [],
    },
    null,
    2,
  ),
);
