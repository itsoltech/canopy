import { Measure, METRIC_DEFINITIONS, WORKER_METRIC_IDS } from "@canopy/domain/diagnostics";
import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

/** One ephemeral report. 256 KiB for sparse measures, 256 KiB for indices, active timings and drain. */
export class WorkerMeasurements {
  readonly values = new Map<number, Measure>();
  readonly counters = new Float64Array(512);
  used = 256 * 1024;
  dropped = 0;
  readonly limit = 512 * 1024;

  reserve = (bytes: number) => {
    if (this.used + bytes > this.limit) {
      this.dropped++;

      return false;
    }

    this.used += bytes;

    return true;
  };

  record(id: number, value: number, at: number, error = false, weight = 0) {
    if (!WORKER_METRIC_IDS.has(id) || !Number.isFinite(value) || value < 0) return;
    const definition = METRIC_DEFINITIONS.get(id)!;

    if (definition.kind === "counter") {
      this.counters[id] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[id]! + value);

      return;
    }

    let measure = this.values.get(id);

    if (!measure) {
      if (!this.reserve(256)) return;
      measure = new Measure(this.reserve);
      this.values.set(id, measure);
    }

    if (definition.kind === "timing") measure.timing(value, error, at);
    else measure.gauge(value, weight, at);
  }

  drain(at: number) {
    for (const id of WORKER_METRIC_IDS) {
      const count = this.counters[id] ?? 0;

      if (!count) continue;
      const value = new Measure();
      value.counter(count, false, at);
      this.values.set(id, value);
    }

    const values = [...this.values].map(([id, value]) => value.snapshot(id));
    this.values.clear();
    this.counters.fill(0);
    this.used = 256 * 1024;

    return values;
  }

  report(value: ui.WorkerLinkDiagnostics) {
    // Counters belong to this exact batch boundary, even if serialization crosses a clock tick.
    value.measures = this.drain(Number(value.endMs));
    value.workerMeasuresSupported = true;
    value.droppedSamples = BigInt(this.dropped);

    while (toBinary(ui.WorkerLinkDiagnosticsSchema, value).length > 32 * 1024 && value.measures.length) {
      value.measures.pop();
      value.droppedSamples = BigInt(++this.dropped);
    }
  }

  reset() {
    if (this.values.size || this.counters.some(Boolean)) this.dropped++;
    this.values.clear();
    this.counters.fill(0);
    this.used = 256 * 1024;
  }
}
