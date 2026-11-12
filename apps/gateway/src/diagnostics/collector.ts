import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  mergeCoverage,
  addCount,
  METRIC_DEFINITIONS,
  metricOf,
  rpcOf,
  type Histogram,
  DiagnosticsTrace,
} from "@canopy/domain/diagnostics";
import { BucketBudget, Buckets } from "./buckets.ts";
import { MAX_METHODS, type RegisteredMethod } from "./registry.ts";
import { updateWindows, resetWindows } from "./windows.ts";
import { DatabaseMeasurements } from "./database-measurements.ts";

export type DiagnosticsClock = { monotonic(): number; utc(): number };

const SYSTEM_CLOCK: DiagnosticsClock = { monotonic: () => performance.now(), utc: () => Date.now() };

export class RpcCollector {
  readonly tracing = new DiagnosticsTrace();
  freshnessMs = 10_000;
  enabled = true;
  gatewayEnabled = true;
  readonly methods = new Map<number, RegisteredMethod>();
  readonly short: Buckets;
  readonly minutes: Buckets;
  readonly historyMinutes: Buckets;
  readonly measureBudget: BucketBudget;
  readonly databaseBudget: BucketBudget;
  readonly windowBudget = new BucketBudget(512 * 1024);
  readonly #rings: readonly Buckets[];
  readonly active = new Map<number, Map<number, number>>();
  historyRevision = 0;
  closedTick = 0;
  readonly session = Bun.randomUUIDv7();
  readonly startedAt: number;
  #lastMono: number;
  #lastUtc: number;
  #sequence = 0n;
  #activeCount = 0;
  #database: DatabaseMeasurements | undefined;
  #generation = 0;

  constructor(
    methods: readonly RegisteredMethod[],
    readonly clock = SYSTEM_CLOCK,
    readonly budget = new BucketBudget(),
  ) {
    // All internal labels, correlations and restored measurements share 1 MiB inside the original 6 MiB.
    this.measureBudget = new BucketBudget(1024 * 1024, budget);
    // SQL cardinality must not consume the space needed by process/queue/governor series.
    this.databaseBudget = new BucketBudget(512 * 1024, this.measureBudget);
    this.short = new Buckets(5_000, 12, budget, this.measureBudget, this.databaseBudget);
    this.minutes = new Buckets(60_000, 61, budget, this.measureBudget, this.databaseBudget);
    this.historyMinutes = new Buckets(60_000, 61, budget, this.measureBudget, this.databaseBudget);
    this.#rings = [this.short, this.minutes];

    if (methods.length > MAX_METHODS) throw new Error("Diagnostics method budget exceeded");

    for (const method of methods) {
      if (this.methods.has(method.id)) throw new Error("Diagnostics descriptor id collision");
      this.methods.set(method.id, method);
    }

    this.startedAt = clock.utc();
    this.#lastMono = clock.monotonic();
    this.#lastUtc = this.startedAt;
  }

  /** At most one clock read and numeric updates per message; no serialization or process sampling. */
  start(id: number) {
    if (!this.enabled) return;
    const method = this.methods.get(id);

    if (!method) {
      this.budget.dropped++;

      return;
    }

    const started = this.clock.monotonic();
    const generation = this.#generation;
    const now = this.#lastUtc + started - this.#lastMono;
    const calls = this.active.get(id) ?? new Map<number, number>();
    // A per-method sequence distinguishes calls that share the same clock value.
    const token = Number(++this.#sequence);

    if (this.#activeCount >= 4096 || !this.budget.reserve(256)) {
      this.budget.dropped++;

      return;
    }

    calls.set(token, started);
    this.#activeCount++;
    this.active.set(id, calls);
    this.#change(now, id, (value) => {
      value.started = addCount(value.started);
      value.maxInFlight = Math.max(value.maxInFlight, calls.size);
    });
    let done = false;
    let first = true;

    return {
      started,
      message: (direction: "request" | "response", bytes?: number, kind = 3) => {
        if (done || generation !== this.#generation) return;
        const elapsed = this.clock.monotonic() - started;
        this.#change(now + elapsed, id, (value) => {
          const index = (direction === "request" ? 0 : 4) + kind;
          value.messageKinds[index] = addCount(value.messageKinds[index]!);

          if (direction === "request") {
            value.requestMessages = addCount(value.requestMessages);

            if (bytes !== undefined) value.requestBytes.record(bytes);
          } else {
            value.responseMessages = addCount(value.responseMessages);

            if (bytes !== undefined) value.responseBytes.record(bytes);

            if (first && method.stream) value.firstMessage.record(elapsed);
          }
        });

        if (direction === "response") first = false;
      },
      finish: (code = 0) => {
        if (done) return;
        done = true;
        calls.delete(token);
        this.#activeCount--;
        this.budget.used -= 256;

        if (generation !== this.#generation) return;
        const elapsed = this.clock.monotonic() - started;
        this.#change(now + elapsed, id, (value) => {
          value.completed = addCount(value.completed);
          const safeCode = Number.isInteger(code) && code >= 0 && code <= 16 ? code : 2;
          value.codes[safeCode] = addCount(value.codes[safeCode]!);
          value.duration.record(elapsed);
          value.slow = addCount(value.slow, elapsed > 1000 ? 1n : 0n);
        });
        this.tracing.record("rpc", id, elapsed, code !== 0);
      },
    };
  }

  #change(now: number, id: number, change: (value: import("@canopy/domain/diagnostics").Aggregate) => void) {
    for (const ring of this.#rings) {
      const value = ring.series(now, id);

      if (value) change(value);
    }
  }

  measurementTime(monotonic: number) {
    return this.#lastUtc + monotonic - this.#lastMono;
  }

  reset() {
    this.flushDatabase();
    this.#generation++;

    for (const ring of [this.short, this.minutes, this.historyMinutes]) ring.expire(Infinity);
    resetWindows(this);
    this.historyRevision++;
  }

  recordDatabase(id: number, elapsed: number, error: boolean, rpc: number, monotonic: number) {
    if (!this.enabled || !this.gatewayEnabled) return;
    this.tracing.record(id % 8 === 0 ? "pool" : "database", id, elapsed, error);
    this.#database ??= new DatabaseMeasurements(this);

    this.#database.record(id, elapsed, error, rpc, monotonic);
  }

  flushDatabase(limit?: number) {
    this.#database?.flush(limit);
  }

  measure(id: number, value: number, error = false, rpc = 0, weight = 0, timestamp?: number) {
    if (!this.enabled || !this.gatewayEnabled || !Number.isFinite(value) || value < 0) return;
    const definition = METRIC_DEFINITIONS.get(id);

    if (!definition || (rpc && !this.methods.has(rpc))) return;

    if (definition.kind === "timing" && (definition.group === "governor" || id === 22))
      this.tracing.record(id === 22 ? "ingest" : "governor", id, value, error);
    const at = timestamp ?? this.measurementTime(this.clock.monotonic());

    for (const ring of this.#rings) {
      const global = ring.measure(at, id);

      if (global) {
        if (definition.kind === "timing") global.timing(value, error, at);
        else if (definition.kind === "counter") global.counter(Math.floor(value), error, at);
        else global.gauge(value, weight, at);
      }

      if (rpc) {
        const associated = ring.measure(at, id, rpc);

        if (associated) {
          if (definition.kind === "timing") associated.timing(value, error, at);
          else if (definition.kind === "counter") associated.counter(Math.floor(value), error, at);
          else associated.gauge(value, weight, at);
        }
      }
    }
  }

  mergeMeasures(values: readonly ui.DiagnosticsMeasureAggregate[], at = this.clock.utc()) {
    for (const ring of this.#rings) for (const value of values) ring.measure(at, value.metricId)?.merge(value);
  }

  tick() {
    this.flushDatabase();
    const mono = this.clock.monotonic();
    const utc = this.clock.utc();
    const elapsed = mono - this.#lastMono;

    if (Math.floor(utc / 60_000) !== Math.floor(this.#lastUtc / 60_000)) this.closedTick++;

    // Sleep, event-loop stalls and wall-clock jumps are gaps, never invented observation time.
    if (elapsed >= 0 && elapsed <= 10_000 && Math.abs(utc - this.#lastUtc - elapsed) < 1000)
      for (const ring of this.#rings) ring.cover(this.#lastUtc, utc);
    this.#lastMono = mono;
    this.#lastUtc = utc;
    this.historyMinutes.expire(Math.floor(utc / 60_000) * 60_000 - 3_540_000);
    this.minutes.expire(Math.floor(utc / 60_000) * 60_000 - 3_600_000);
    updateWindows(this);
  }

  restore(process: ui.DiagnosticsProcess, at: number) {
    if (at >= this.startedAt || at < this.startedAt - 3_600_000) return;
    // Historical sessions participate in reads, never in this session's persisted minute.
    this.#restoreHistory(this.historyMinutes, process, at);
    this.historyRevision++;
  }

  #restoreHistory(ring: Buckets, process: ui.DiagnosticsProcess, at: number) {
    // Restore may shed older detail, but must leave room for new RPCs and minute writes.
    const limit = Math.floor(this.budget.limit * 0.5);

    while (
      this.budget.used + ring.restoreBytes(process, at) > limit ||
      this.measureBudget.used + ring.restoreMeasureBytes(process, at) > this.measureBudget.limit / 2 ||
      this.databaseBudget.used + ring.restoreMeasureBytes(process, at, true) > this.databaseBudget.limit / 2
    ) {
      if (this.historyMinutes.evictOldest()) {
        this.budget.dropped++;
        continue;
      }

      this.budget.dropped += process.series.length + process.measures.length;

      return;
    }

    const slot = ring.slot(at);

    if (!slot) return;
    slot.coverage = mergeCoverage([...slot.coverage, ...process.coverage]);

    for (const value of process.series)
      if (this.methods.has(value.methodId)) ring.series(at, value.methodId)?.merge(value);
    ring.restoreMeasures(process, at);
  }

  merge(process: ui.DiagnosticsProcess, at = this.clock.utc()) {
    for (const ring of this.#rings) ring.restore(process, at);
  }

  mergeHistogram(id: number, histogram: ui.DiagnosticsHistogram | Histogram, timeouts = 0n) {
    const at = this.clock.utc();

    for (const ring of this.#rings) {
      const value = ring.series(at, id);

      if (!value) continue;
      value.duration.merge(histogram);
      value.codes[4] = addCount(value.codes[4]!, timeouts);
    }
  }

  rollup(at: number) {
    this.flushDatabase();
    const slot = this.minutes.slots.find((value) => value?.at === at);

    if (!slot) return;

    return create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session: this.session,
      sequence: BigInt(at),
      coverage: mergeCoverage(slot.coverage),
      series: [...slot.series].map(([id, value]) => value.snapshot(id)),
      measures: [...(slot.measures ?? [])].map(([key, value]) => value.snapshot(metricOf(key), rpcOf(key))),
    });
  }
}

export type RpcObservation = NonNullable<ReturnType<RpcCollector["start"]>>;
