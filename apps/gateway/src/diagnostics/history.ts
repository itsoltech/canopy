import { Aggregate, mergeCoverage } from "@canopy/domain/diagnostics";
import type { DiagnosticsStore } from "./store.ts";
import { BucketBudget, type Slot } from "./buckets.ts";
import { decodeRollup } from "./rollup.ts";
import { restoreMeasures } from "./measure-snapshot.ts";

/** One short-lived, shared hourly view. No historical query is part of gateway startup. */
export class DiagnosticsHistory {
  values = new Map<string, Slot>();
  dropped = 0;
  revision = 0;
  #at = 0;
  #hour = 0;
  #loading: Promise<void> | undefined;

  constructor(
    readonly store: DiagnosticsStore,
    readonly allowed: (process: string, method: number) => boolean,
  ) {}

  load(now: number) {
    const hour = Math.floor(now / 3_600_000) * 3_600_000;

    if (this.#hour === hour && now - this.#at < 5000) return Promise.resolve();
    this.#loading ??= this.#read(now, hour).finally(() => {
      this.#loading = undefined;
    });

    return this.#loading;
  }

  async #read(now: number, hour: number) {
    const start = hour - 23 * 3_600_000;

    // A just-completed hour may still await its first write/maintenance after a crash.
    // Only that hour may fall back to minutes: never scan the old minute retention.
    const rows = await this.store.query<{ payload: Uint8Array }>(
      `SELECT r.payload FROM diagnostics_rollups r WHERE owner_user_id=$1::uuid AND computer_id=$2
       AND bucket_start>=to_timestamp($3/1000.0) AND bucket_start<to_timestamp($4/1000.0)
       AND (resolution=3600 OR (resolution=60 AND bucket_start>=to_timestamp(($4-3600000)/1000.0)
         AND NOT EXISTS (SELECT 1 FROM diagnostics_rollups h WHERE h.owner_user_id=r.owner_user_id
           AND h.computer_id=r.computer_id AND h.resolution=3600 AND h.bucket_start=date_trunc('hour',r.bucket_start))))
       ORDER BY resolution DESC,bucket_start LIMIT 84`,
      [this.store.owner, this.store.computer, start, hour],
    );

    const budget = new BucketBudget(1024 * 1024);
    const values = new Map<string, Slot>();

    for (const row of rows) {
      const rollup = decodeRollup(row.payload);

      if (rollup.incomplete) budget.dropped++;

      for (const process of rollup.processes) {
        let slot = values.get(process.processId);

        if (!slot) {
          if (
            values.size >= 17 ||
            (!process.series.some((series) => this.allowed(process.processId, series.methodId)) &&
              !((process.processId === "gateway" || this.allowed(process.processId, 1)) && process.measures.length))
          ) {
            budget.dropped++;
            continue;
          }

          slot = { at: start, coverage: [], series: new Map() };
          values.set(process.processId, slot);
        }

        slot.coverage = mergeCoverage([...slot.coverage, ...process.coverage]);

        restoreMeasures(
          slot,
          process,
          (bytes) => budget.reserve(bytes),
          (id) => this.allowed(process.processId, id),
        );

        for (const series of process.series) {
          if (!this.allowed(process.processId, series.methodId)) continue;
          let value = slot.series.get(series.methodId);

          if (!value) {
            if (!budget.reserve(1600)) continue;
            value = new Aggregate(true, (bytes) => budget.reserve(bytes));
            slot.series.set(series.methodId, value);
          }

          value.merge(series);
        }
      }
    }

    this.values = values;
    this.revision++;
    this.dropped = budget.dropped;
    this.#at = now;
    this.#hour = hour;
  }
}
