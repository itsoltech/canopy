import { Schema } from "effect";

export const BenchCommand = Schema.Struct({
  id: Schema.Number,
  action: Schema.Literals(["begin", "end", "sample", "stop", "reconnect"]),
});

export type BenchCommand = typeof BenchCommand.Type;

export const ProcessStats = Schema.Struct({
  cpuMicros: Schema.Number,
  elapsedMs: Schema.Number,
  rss: Schema.Number,
  heap: Schema.Number,
  eventLoopP99Ms: Schema.Number,
  eventLoopMaxMs: Schema.Number,
});

export const BenchStats = Schema.Struct({
  ...ProcessStats.fields,
  walBytes: Schema.Number,
  rollupBytes: Schema.Number,
  rows: Schema.Number,
  writes: Schema.Number,
  allocatedBytes: Schema.Number,
  dropped: Schema.Number,
  restoreMs: Schema.Number,
  tableBytes: Schema.Number,
  indexBytes: Schema.Number,
  deadTuples: Schema.Number,
  autovacuumCount: Schema.Number,
});

export type BenchStats = typeof BenchStats.Type;

export const WorkerBenchReply = Schema.Struct({
  id: Schema.Number,
  stats: Schema.optional(ProcessStats),
});

export const BenchReply = Schema.Struct({
  id: Schema.Number,
  stats: Schema.optional(BenchStats),
  error: Schema.Boolean,
});
