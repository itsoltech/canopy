import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Aggregate, Measure, measureKey, METRIC_DEFINITIONS, mergeCoverage } from "@canopy/domain/diagnostics";

export type Slot = {
  at: number;
  coverage: ui.DiagnosticsCoverage[];
  series: Map<number, Aggregate>;
  measures?: Map<number, Measure>;
};

/** Allocations, including conservative object/Map overhead, share one process budget. */
export class BucketBudget {
  used = 0;
  dropped = 0;
  constructor(readonly limit = 6 * 1024 * 1024) {}

  reserve(bytes: number) {
    if (this.used + bytes > this.limit) {
      this.dropped++;

      return false;
    }

    this.used += bytes;

    return true;
  }
}

const SLOT_BYTES = 2048;
const AGGREGATE_BYTES = 1536;

function slotBytes(slot: Slot) {
  let bytes = SLOT_BYTES;

  for (const aggregate of slot.series.values()) bytes += aggregate.bytes;

  for (const measure of slot.measures?.values() ?? []) bytes += measure.bytes;

  return bytes;
}

export class Buckets {
  readonly slots: (Slot | undefined)[];
  constructor(
    readonly width: number,
    readonly count: number,
    readonly budget: BucketBudget,
  ) {
    this.slots = Array.from<Slot | undefined>({ length: count });
  }

  slot(now: number): Slot | undefined {
    const at = Math.floor(now / this.width) * this.width;
    const index = Math.floor(at / this.width) % this.count;
    let slot = this.slots[index];

    if (slot?.at !== at) {
      if (slot) {
        this.budget.used -= slotBytes(slot);
        this.slots[index] = undefined;
      }

      if (!this.budget.reserve(SLOT_BYTES)) return;
      slot = { at, series: new Map(), coverage: [] };
      this.slots[index] = slot;
    }

    return slot;
  }

  series(now: number, id: number) {
    const slot = this.slot(now);

    if (!slot) return;
    let series = slot.series.get(id);

    if (!series && this.budget.reserve(AGGREGATE_BYTES)) {
      series = new Aggregate(true, (bytes) => this.budget.reserve(bytes));
      slot.series.set(id, series);
    }

    return series;
  }

  measure(now: number, id: number, rpc = 0) {
    if (!METRIC_DEFINITIONS.has(id)) return;
    const slot = this.slot(now);

    if (!slot) return;
    const key = measureKey(id, rpc);
    let value = slot.measures?.get(key);

    if (!value) {
      // Correlations are optional detail. Global family/resource series keep their space.
      if (rpc && (slot.measures?.size ?? 0) >= 192) {
        this.budget.dropped++;

        return;
      }

      if (!this.budget.reserve(256)) return;
      value = new Measure((bytes) => this.budget.reserve(bytes));
      slot.measures ??= new Map();
      slot.measures.set(key, value);
    }

    return value;
  }

  restoreMeasures(process: ui.DiagnosticsProcess, at: number) {
    for (const value of process.measures) this.measure(at, value.metricId, value.rpcMethodId)?.merge(value);
  }

  cover(start: number, end: number) {
    for (let at = start; at < end;) {
      const stop = Math.min(end, (Math.floor(at / this.width) + 1) * this.width);
      const slot = this.slot(at);

      if (slot) {
        const last = slot.coverage.at(-1);

        if (last && last.endMs === BigInt(Math.floor(at))) last.endMs = BigInt(Math.floor(stop));
        else if (slot.coverage.length < 64)
          slot.coverage.push(
            create(ui.DiagnosticsCoverageSchema, {
              startMs: BigInt(Math.floor(at)),
              endMs: BigInt(Math.floor(stop)),
            }),
          );
        else this.budget.dropped++;
      }

      at = stop;
    }
  }

  restore(process: ui.DiagnosticsProcess, at: number) {
    const slot = this.slot(at);

    if (!slot) return;
    slot.coverage = mergeCoverage([...slot.coverage, ...process.coverage]);

    for (const value of process.series) this.series(at, value.methodId)?.merge(value);
    this.restoreMeasures(process, at);
  }

  restoreBytes(process: ui.DiagnosticsProcess, at: number) {
    const bucket = Math.floor(at / this.width) * this.width;
    const slot = this.slots.find((value) => value?.at === bucket);

    return (
      (slot ? 0 : SLOT_BYTES) +
      process.series.filter((value) => !slot?.series.has(value.methodId)).length * AGGREGATE_BYTES +
      process.measures.reduce(
        (sum, value) =>
          sum +
          (slot?.measures?.has(measureKey(value.metricId, value.rpcMethodId))
            ? 0
            : 384 + (value.histogram?.indices.length ?? 0) * 48),
        0,
      )
    );
  }

  evictOldest(before = Infinity) {
    const oldest = this.slots.reduce<Slot | undefined>(
      (previous, slot) => (slot && slot.at < before && (!previous || slot.at < previous.at) ? slot : previous),
      undefined,
    );

    if (!oldest) return false;
    this.slots[Math.floor(oldest.at / this.width) % this.count] = undefined;
    this.budget.used -= slotBytes(oldest);

    return true;
  }

  expire(before: number) {
    while (this.evictOldest(before)) {}
  }

  between(start: number, end: number) {
    return this.slots.filter((slot): slot is Slot => Boolean(slot && slot.at >= start && slot.at < end));
  }
}
