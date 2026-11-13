import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { WORKER_METRIC_IDS, METRIC_DEFINITIONS } from "@canopy/domain/diagnostics";

export function validHistogram(histogram: ui.DiagnosticsHistogram) {
  return (
    histogram.indices.length <= 130 &&
    histogram.indices.length === histogram.counts.length &&
    histogram.indices.every((index, at) => index <= 129 && (!at || index > histogram.indices[at - 1]!)) &&
    histogram.counts.every((count) => count > 0n && count <= 0xffff_ffffn) &&
    [histogram.sum, histogram.max, histogram.min ?? 0].every((v) => Number.isFinite(v) && v >= 0) &&
    (histogram.min ?? 0) <= histogram.max
  );
}

export function cleanHistogram(value: ui.DiagnosticsHistogram) {
  return create(ui.DiagnosticsHistogramSchema, {
    indices: [...value.indices],
    counts: [...value.counts],
    sum: value.sum,
    max: value.max,
    ...(value.min !== undefined && { min: value.min }),
  });
}

export function reportBytes(value: ui.WorkerLinkDiagnostics) {
  const histogramBytes = (row: ui.DiagnosticsHistogram | undefined) => (row ? 144 + row.indices.length * 48 : 0);

  return (
    4096 +
    histogramBytes(value.rtt) +
    histogramBytes(value.jitter) +
    value.measures.reduce((sum, row) => sum + 256 + histogramBytes(row.histogram), 0)
  );
}

/** Rebuild at the untrusted WorkerLink boundary: no unknown fields, text or RPC identities survive. */
export function workerMeasures(value: ui.WorkerLinkDiagnostics) {
  if (value.measures.length > 64 || toBinary(ui.WorkerLinkDiagnosticsSchema, value).length > 32 * 1024) return;
  const seen = new Set<number>();
  const measures: ui.DiagnosticsMeasureAggregate[] = [];

  for (const row of value.measures) {
    const histogram = row.histogram;

    if (
      !WORKER_METRIC_IDS.has(row.metricId) ||
      seen.has(row.metricId) ||
      row.rpcMethodId ||
      ![row.weight, row.weightedSum, row.max, row.last].every((v) => Number.isFinite(v) && v >= 0) ||
      row.weight > 60_000 ||
      row.events > 0xffff_ffffn ||
      row.errors > row.events ||
      row.sampledAtMs < value.startMs ||
      row.sampledAtMs > value.endMs
    )
      return;
    const kind = METRIC_DEFINITIONS.get(row.metricId)!.kind;

    if (
      histogram &&
      (!validHistogram(histogram) ||
        kind !== "timing" ||
        histogram.counts.reduce((sum, count) => sum + count, 0n) > row.events)
    )
      return;

    if (kind !== "gauge" && (row.weight || row.weightedSum || row.max || row.last)) return;
    seen.add(row.metricId);
    measures.push(
      create(ui.DiagnosticsMeasureAggregateSchema, {
        metricId: row.metricId,
        events: row.events,
        errors: row.errors,
        weight: row.weight,
        weightedSum: row.weightedSum,
        max: row.max,
        last: row.last,
        sampledAtMs: row.sampledAtMs,
        incomplete: row.incomplete,
        histogram: histogram ? cleanHistogram(histogram) : undefined,
      }),
    );
  }

  return measures;
}
