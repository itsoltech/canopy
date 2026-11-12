import { median, type PairedDelta } from "./diagnostics-paired.ts";

/** With two controls this is a descriptive envelope, not a confidence interval. */
export function latencyNoise(measured: readonly PairedDelta[], controls: readonly PairedDelta[]) {
  const phases = [...new Set(measured.flatMap((row) => (row.metric === "rpc.p95Ms" ? [row.phase] : [])))];

  return phases.map((phase) => {
    const aa = controls.filter((row) => row.phase === phase && row.metric === "rpc.p95Ms");

    if (aa.length < 2) throw new Error("Two accepted A/A control pairs are required for every RPC phase");
    const absolute = aa.map((row) => Math.abs(row.delta));
    const floorMs = Math.max(...absolute);

    const deltaMs = median(
      measured.flatMap((row) => (row.phase === phase && row.metric === "rpc.p95Ms" ? [row.delta] : [])),
    )!;

    const limitMs = Math.max(0.25, floorMs);

    return {
      phase,
      controlN: aa.length,
      controlPairDeltasMs: aa.map((row) => row.delta),
      medianAbsoluteControlMs: median(absolute),
      floorMs,
      limitMs,
      deltaMs,
      withinNoiseOrTarget: deltaMs <= limitMs,
    };
  });
}
