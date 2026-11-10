import { Schema } from "effect";

export const BenchCommand = Schema.Struct({ id: Schema.Number, action: Schema.Literals(["begin", "end", "stop"]) });

export type BenchCommand = typeof BenchCommand.Type;

export const BenchStats = Schema.Struct({
  cpuMicros: Schema.Number,
  elapsedMs: Schema.Number,
  rss: Schema.Number,
  heap: Schema.Number,
  eventLoopP99Ms: Schema.Number,
  eventLoopMaxMs: Schema.Number,
  walBytes: Schema.Number,
  rollupBytes: Schema.Number,
  rows: Schema.Number,
  writes: Schema.Number,
  allocatedBytes: Schema.Number,
  dropped: Schema.Number,
  restoreMs: Schema.Number,
});

export type BenchStats = typeof BenchStats.Type;

export const BenchReply = Schema.Struct({
  id: Schema.Number,
  stats: Schema.optional(BenchStats),
  error: Schema.Boolean,
});
