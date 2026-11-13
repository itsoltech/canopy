import { Schema } from "effect";

export const MemberResult = Schema.Struct({
  phase: Schema.Literal("member_end"),
  pair: Schema.Number,
  attempt: Schema.Number,
  accepted: Schema.Boolean,
  maxLoad: Schema.Number,
  samples: Schema.Number,
  swapInBytes: Schema.Number,
  swapOutBytes: Schema.Number,
  peakSwapInKiBPerSec: Schema.Number,
  peakSwapOutKiBPerSec: Schema.Number,
  longestSwapInThresholdRun: Schema.Number,
  violations: Schema.Array(Schema.Struct({ kind: Schema.String, value: Schema.String })),
});

/** Acceptance and counters cover both fresh members; a partial first member never qualifies. */
export function pairResult(pair: number, attempt: number, members: readonly (typeof MemberResult.Type)[]) {
  const sum = (key: "samples" | "swapInBytes" | "swapOutBytes") => members.reduce((n, row) => n + row[key], 0);

  const max = (key: "maxLoad" | "peakSwapInKiBPerSec" | "peakSwapOutKiBPerSec" | "longestSwapInThresholdRun") =>
    Math.max(0, ...members.map((row) => row[key]));

  if (members.some((row) => row.pair !== pair || row.attempt !== attempt)) throw new Error("Mismatched member result");

  return {
    phase: "pair_end",
    pair,
    attempt,
    accepted: members.length === 2 && members.every((row) => row.accepted),
    samples: sum("samples"),
    swapInBytes: sum("swapInBytes"),
    swapOutBytes: sum("swapOutBytes"),
    maxLoad: max("maxLoad"),
    peakSwapInKiBPerSec: max("peakSwapInKiBPerSec"),
    peakSwapOutKiBPerSec: max("peakSwapOutKiBPerSec"),
    longestSwapInThresholdRun: max("longestSwapInThresholdRun"),
    violations: members.flatMap((row) => row.violations),
  };
}
