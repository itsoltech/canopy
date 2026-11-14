import type { RpcCollector } from "./collector.ts";
import { DATABASE_FAMILIES, metricOf } from "@canopy/domain/diagnostics";

const CAPACITY = 1024;
const STRIDE = 4;

/** Numeric samples only; no query, result, error, promise or finalizer can enter this buffer.
 * The 20 ms sampler drains it outside SQL completion. Reads/rollups drain before taking a view.
 */
export class DatabaseMeasurements {
  readonly #values: Float64Array;
  readonly #lost: Uint8Array;
  #head = 0;
  #size = 0;

  constructor(readonly collector: RpcCollector) {
    this.#values = new Float64Array(collector.budget.reserve(CAPACITY * STRIDE * 8 + 512) ? CAPACITY * STRIDE : 0);
    this.#lost = new Uint8Array(this.#values.length ? DATABASE_FAMILIES.length : 0);
  }

  record(id: number, elapsed: number, error: boolean, rpc: number, monotonic: number) {
    if (!this.#values.length || this.#size === CAPACITY) {
      this.collector.budget.drop("sql_buffer", this.collector.measurementTime(monotonic));
      this.#lost[Math.floor((id - 1000) / 8)] = 1;

      return;
    }

    const at = ((this.#head + this.#size++) % CAPACITY) * STRIDE;
    this.#values[at] = error ? -id : id;
    this.#values[at + 1] = elapsed;
    this.#values[at + 2] = rpc;
    this.#values[at + 3] = this.collector.measurementTime(monotonic);
  }

  flush(limit = CAPACITY) {
    for (let count = 0; this.#size && count < limit; count++) {
      const at = this.#head * STRIDE;
      const signed = this.#values[at]!;
      const id = Math.abs(signed);
      const elapsed = this.#values[at + 1]!;
      const rpc = this.#values[at + 2]!;
      const time = this.#values[at + 3]!;
      this.#head = (this.#head + 1) % CAPACITY;
      this.#size--;
      this.collector.measure(id, elapsed, signed < 0, rpc, 0, time);

      if (id % 8 === 1) {
        this.collector.measure(11, 1, false, 0, 0, time);

        if (id === 1001) this.collector.measure(10, 1, false, 0, 0, time);
      }

      if (id % 8 === 0) this.collector.measure(12, elapsed, signed < 0, 0, 0, time);
    }

    if (!this.#size && this.#lost.some(Boolean)) {
      for (const ring of [this.collector.short, this.collector.minutes])
        for (const slot of ring.slots)
          for (const [key, value] of slot?.measures ?? []) {
            const id = metricOf(key);

            if (this.#lost[Math.floor((id - 1000) / 8)] || id === 11 || id === 12 || (id === 10 && this.#lost[0]))
              value.incomplete = true;
          }

      this.#lost.fill(0);
    }
  }
}
