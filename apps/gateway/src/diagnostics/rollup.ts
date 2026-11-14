import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { mergeAggregates, mergeCoverage, Measure, measureKey, metricOf, rpcOf } from "@canopy/domain/diagnostics";

export const MAX_PAYLOAD = 64 * 1024;

/** Watermarks name sessions: a heartbeat-only bucket cannot replace a report checkpoint. */
export function mergeWatermarks(previous: ui.DiagnosticsProcess[], incoming: ui.DiagnosticsProcess[]) {
  const values = new Map(previous.map((value) => [`${value.processId}:${value.session}`, value]));

  for (const value of incoming) {
    if (!value.sequence || !value.session) continue;
    const key = `${value.processId}:${value.session}`;
    const old = values.get(key);

    if (!old || value.sequence > old.sequence) {
      values.delete(key);
      values.set(key, value);
    }
  }

  return [...values.values()].slice(-126);
}

export function decodeRollup(bytes: Uint8Array) {
  if (bytes.length > MAX_PAYLOAD) throw new Error("Diagnostics rollup exceeds budget");
  const value = fromBinary(ui.DiagnosticsRollupSchema, bytes);

  if (value.schemaVersion !== 1 || value.processes.length > 64) throw new Error("Unsupported diagnostics rollup");

  return value;
}

export function encodeRollup(processes: ui.DiagnosticsProcess[], incomplete = false) {
  if (processes.length > 64) throw new Error("Diagnostics process budget exceeded");

  const rollup = create(ui.DiagnosticsRollupSchema, {
    schemaVersion: 1,
    incomplete,
    processes: processes.map((value) =>
      create(ui.DiagnosticsProcessSchema, { ...value, measures: [...value.measures] }),
    ),
  });

  let bytes = toBinary(ui.DiagnosticsRollupSchema, rollup);

  if (bytes.length > MAX_PAYLOAD) {
    // Optional RPC correlations are shed before global series, RPC counters or link watermarks.
    for (const value of rollup.processes) value.measures = value.measures.filter((measure) => !measure.rpcMethodId);
    rollup.incomplete = true;
    bytes = toBinary(ui.DiagnosticsRollupSchema, rollup);
  }

  let upperBound = bytes.length;

  while (upperBound > MAX_PAYLOAD && rollup.processes.some((value) => value.measures.length)) {
    const removed = rollup.processes.findLast((value) => value.measures.length)!.measures.pop()!;
    // Removing a repeated message can only shrink its enclosing length prefix as well.
    upperBound -= toBinary(
      ui.DiagnosticsProcessSchema,
      create(ui.DiagnosticsProcessSchema, { measures: [removed] }),
    ).length;
  }

  if (upperBound > MAX_PAYLOAD) throw new Error("Diagnostics persistence budget exceeded");

  if (upperBound !== bytes.length) bytes = toBinary(ui.DiagnosticsRollupSchema, rollup);

  return bytes;
}

/** Retry replaces the same session's bucket; different instances/sessions retain their observations. */
export function replaceProcesses(previous: ui.DiagnosticsProcess[], incoming: ui.DiagnosticsProcess[]) {
  const processes = new Map(previous.map((process) => [`${process.processId}:${process.session}`, process]));

  for (const process of incoming) {
    const key = `${process.processId}:${process.session}`;
    const existing = processes.get(key);

    if (!existing || existing.sequence <= process.sequence) processes.set(key, process);
  }

  return [...processes.values()];
}

/** Downsampling sums buckets, preserving process identity, sparse histograms and actual coverage. */
export function compactRollups(rollups: readonly ui.DiagnosticsRollup[]) {
  const grouped = new Map<string, ui.DiagnosticsProcess[]>();

  for (const rollup of rollups)
    for (const process of rollup.processes) {
      const values = grouped.get(process.processId) ?? [];
      values.push(process);
      grouped.set(process.processId, values);
    }

  return [...grouped].map(([processId, values]) => {
    const series = new Map<number, ui.DiagnosticsAggregate[]>();
    const measures = new Map<number, Measure>();

    for (const process of values)
      for (const aggregate of process.series) {
        const bucket = series.get(aggregate.methodId) ?? [];
        bucket.push(aggregate);
        series.set(aggregate.methodId, bucket);
      }

    for (const process of values)
      for (const value of process.measures) {
        const key = measureKey(value.metricId, value.rpcMethodId);
        const aggregate = measures.get(key) ?? new Measure();
        aggregate.merge(value);
        measures.set(key, aggregate);
      }

    return create(ui.DiagnosticsProcessSchema, {
      processId,
      session: "hour",
      sequence: 0n,
      coverage: mergeCoverage(values.flatMap((process) => process.coverage)),
      series: [...series].map(([id, aggregates]) => mergeAggregates(aggregates, id)),
      measures: [...measures].map(([key, value]) => value.snapshot(metricOf(key), rpcOf(key))),
      droppedSamples: values.reduce((sum, process) => sum + process.droppedSamples, 0n),
      limitReasons: [...new Set(values.flatMap((process) => process.limitReasons))],
    });
  });
}
