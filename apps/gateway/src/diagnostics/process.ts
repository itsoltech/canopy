import { processGovernor, type ProcessObserver } from "@canopy/process-governor";
import { governorMetric } from "@canopy/domain/diagnostics";
import type { RpcCollector } from "./collector.ts";
import { databaseMonitor } from "./database.ts";
import { Effect } from "effect";
import type { CoreRuntime } from "../core/core-context.ts";

/** The singleton governor must not retain a runtime, operation or admission callback. */
const governorObserver = (collector: RpcCollector): ProcessObserver => (kind, priority, event, elapsed) => {
  collector.measure(governorMetric(kind, priority, event), event === "wait" || event === "execution" ? elapsed : 1);
};

/** Numeric hooks only. No operation identities or arguments cross this boundary. */
export class ProcessDiagnostics {
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopGovernor: (() => void) | undefined;
  #cpu = process.cpuUsage();
  #sampled = performance.now();
  #expected = 0;
  #statsBusy = false;

  constructor(
    readonly collector: RpcCollector,
    readonly runtime: CoreRuntime,
  ) {
    const monitor = databaseMonitor(runtime);

    if (monitor) monitor.collector = collector;
  }

  start() {
    if (!this.collector.enabled || !this.collector.gatewayEnabled || this.#timer) return;
    const monitor = databaseMonitor(this.runtime);

    if (monitor) monitor.collector = this.collector;
    this.#cpu = process.cpuUsage();
    this.#sampled = performance.now();
    this.#stopGovernor = processGovernor.observe(governorObserver(this.collector));
    this.#expected = performance.now() + 20;
    this.#timer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - this.#expected);
      this.#expected = now + 20;

      // Suspend and long scheduling gaps do not become invented loop samples.
      if (lag < 10_000) this.collector.measure(1, lag);
      this.collector.flushDatabase(256);
    }, 20);
    this.#timer.unref();
  }

  sample() {
    if (!this.collector.enabled || !this.collector.gatewayEnabled) return 0;
    const now = performance.now();
    const elapsed = now - this.#sampled;
    const cpu = process.cpuUsage(this.#cpu);
    this.#cpu = process.cpuUsage();
    this.#sampled = now;
    const memory = process.memoryUsage();
    const weight = elapsed > 0 && elapsed <= 10_000 ? elapsed : 0;

    if (weight) this.collector.measure(2, (cpu.user + cpu.system) / (elapsed * 10), false, 0, weight);
    this.collector.measure(3, memory.rss, false, 0, weight);
    this.collector.measure(4, memory.heapUsed, false, 0, weight);
    this.collector.measure(5, memory.heapTotal, false, 0, weight);
    this.collector.measure(6, process.uptime(), false, 0, weight);
    const governor = processGovernor.snapshot();
    this.collector.measure(37, governor.active, false, 0, weight);
    this.collector.measure(38, governor.queued, false, 0, weight);
    const db = databaseMonitor(this.runtime);

    if (db) {
      this.collector.measure(7, db.peakWaiting, false, 0, 0);
      this.collector.measure(7, db.waiting, false, 0, weight);
      this.collector.measure(8, db.peakOccupied, false, 0, 0);
      this.collector.measure(8, db.occupied, false, 0, weight);
      this.collector.measure(9, db.capacity, false, 0, weight);

      if (db.stats && !this.#statsBusy) {
        this.#statsBusy = true;
        void Effect.runPromise(db.stats)
          .then((stats) => {
            db.capacity = stats.max;
          })
          .catch(() => {})
          .finally(() => {
            this.#statsBusy = false;
          });
      }
      db.peakWaiting = db.waiting;
      db.peakOccupied = db.occupied;
    }

    return weight;
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopGovernor?.();
    this.#stopGovernor = undefined;
    const db = databaseMonitor(this.runtime);

    if (db?.collector === this.collector) db.collector = undefined;
  }
}
