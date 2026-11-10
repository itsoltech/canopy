import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { mergeAggregates, mergeCoverage } from "@canopy/domain/diagnostics";

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

export function encodeRollup(processes: ui.DiagnosticsProcess[]) {
  if (processes.length > 64) throw new Error("Diagnostics process budget exceeded");

  const bytes = toBinary(
    ui.DiagnosticsRollupSchema,
    create(ui.DiagnosticsRollupSchema, { schemaVersion: 1, processes }),
  );

  if (bytes.length > MAX_PAYLOAD) throw new Error("Diagnostics persistence budget exceeded");

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

    for (const process of values)
      for (const aggregate of process.series) {
        const bucket = series.get(aggregate.methodId) ?? [];
        bucket.push(aggregate);
        series.set(aggregate.methodId, bucket);
      }

    return create(ui.DiagnosticsProcessSchema, {
      processId,
      session: "hour",
      sequence: 0n,
      coverage: mergeCoverage(values.flatMap((process) => process.coverage)),
      series: [...series].map(([id, aggregates]) => mergeAggregates(aggregates, id)),
    });
  });
}
