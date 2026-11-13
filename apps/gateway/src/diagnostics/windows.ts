import { Aggregate, mergeCoverage, MAX_COUNT } from "@canopy/domain/diagnostics";
import type { Slot, BucketBudget } from "./buckets.ts";
import type { RpcCollector } from "./collector.ts";

/** Closed minutes enter/leave each rolling sum once. Current-minute mutations stay separate. */
class RollingWindow {
  limited = false;
  #bytes = 0;
  values = new Map<number, Aggregate>();
  slots = new Set<Slot>();
  revision = -1;
  minute = -1;
  closedTick = -1;
  coverage: Slot["coverage"] = [];

  constructor(readonly budget: BucketBudget) {}

  #reserve(bytes: number) {
    if (!this.budget.reserve(bytes)) {
      this.limited = true;

      return false;
    }

    this.#bytes += bytes;

    return true;
  }

  #clear() {
    this.budget.used -= this.#bytes;
    this.#bytes = 0;
    this.values.clear();
  }

  update(collector: RpcCollector, start: number, end: number) {
    if (this.minute === end && this.revision === collector.historyRevision && this.closedTick === collector.closedTick)
      return this;
    const next = new Set([...collector.minutes.between(start, end), ...collector.historyMinutes.between(start, end)]);

    // Rebuild after restore/expiry or saturation, where subtracting a clipped count is ambiguous.
    if (
      this.limited ||
      this.revision !== collector.historyRevision ||
      [...this.values.values()].some(
        (value) =>
          value.incomplete ||
          value.started === MAX_COUNT ||
          value.completed === MAX_COUNT ||
          value.duration.incomplete ||
          value.firstMessage.incomplete ||
          value.requestBytes.incomplete ||
          value.responseBytes.incomplete,
      )
    ) {
      this.#clear();
      this.slots.clear();
    }

    this.limited = false;

    for (const slot of this.slots)
      if (!next.has(slot)) for (const [id, value] of slot.series) this.values.get(id)?.subtract(value);

    for (const slot of next)
      if (!this.slots.has(slot))
        for (const [id, value] of slot.series) {
          let aggregate = this.values.get(id);

          if (!aggregate) {
            if (!this.#reserve(1600)) continue;
            aggregate = new Aggregate(true, (bytes) => this.#reserve(bytes));
            this.values.set(id, aggregate);
          }

          aggregate.merge(value);
        }

    // Extrema are not additive. Refresh them from bounded sparse minutes at rollover only.
    for (const aggregate of this.values.values()) {
      aggregate.maxInFlight = 0;
      aggregate.duration.max =
        aggregate.firstMessage.max =
        aggregate.requestBytes.max =
        aggregate.responseBytes.max =
          0;
      aggregate.duration.min =
        aggregate.firstMessage.min =
        aggregate.requestBytes.min =
        aggregate.responseBytes.min =
          Infinity;
    }

    const present = new Set<number>();

    for (const slot of next)
      for (const [id, value] of slot.series) {
        present.add(id);
        const aggregate = this.values.get(id);

        if (!aggregate) continue;
        aggregate.maxInFlight = Math.max(aggregate.maxInFlight, value.maxInFlight);

        for (const name of ["duration", "firstMessage", "requestBytes", "responseBytes"] as const) {
          aggregate[name].max = Math.max(aggregate[name].max, value[name].max);
          aggregate[name].min = Math.min(aggregate[name].min, value[name].min);
        }
      }

    for (const id of this.values.keys()) if (!present.has(id)) this.values.delete(id);
    this.coverage = mergeCoverage([...next].flatMap((slot) => slot.coverage));
    this.slots = next;
    this.minute = end;
    this.revision = collector.historyRevision;
    this.closedTick = collector.closedTick;

    if (this.limited) this.#clear();

    return this;
  }
}

const windows = new WeakMap<RpcCollector, Map<number, RollingWindow>>();

export function closedWindow(collector: RpcCollector, minutes: number, start: number, end: number) {
  let views = windows.get(collector);

  if (!views) {
    views = new Map();
    windows.set(collector, views);
  }

  let view = views.get(minutes);

  if (!view) {
    view = new RollingWindow(collector.windowBudget);
    views.set(minutes, view);
  }

  return view.update(collector, start, end);
}

export function updateWindows(collector: RpcCollector) {
  const now = collector.clock.utc();
  const end = Math.floor(now / 60_000) * 60_000;
  closedWindow(collector, 15, end - 14 * 60_000, end);
  closedWindow(collector, 60, end - 59 * 60_000, end);
  closedWindow(collector, 1440, Math.floor(now / 3_600_000) * 3_600_000, end);
}
