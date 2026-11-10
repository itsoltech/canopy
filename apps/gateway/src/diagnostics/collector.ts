import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { mergeCoverage, addCount } from "@canopy/domain/diagnostics";
import { BucketBudget, Buckets } from "./buckets.ts";
import type { RegisteredMethod } from "./registry.ts";

export type DiagnosticsClock = { monotonic(): number; utc(): number };

const SYSTEM_CLOCK: DiagnosticsClock = { monotonic: () => performance.now(), utc: () => Date.now() };

export class RpcCollector {
  enabled = true;
  readonly methods = new Map<number, RegisteredMethod>();
  readonly short: Buckets;
  readonly minutes: Buckets;
  readonly quarters: Buckets;
  readonly historyMinutes: Buckets;
  readonly historyQuarters: Buckets;
  readonly active = new Map<number, Map<number, number>>();
  historyRevision = 0;
  readonly session = Bun.randomUUIDv7();
  readonly startedAt: number;
  #lastMono: number;
  #lastUtc: number;
  #sequence = 0n;
  #activeCount = 0;

  constructor(
    methods: readonly RegisteredMethod[],
    readonly clock = SYSTEM_CLOCK,
    readonly budget = new BucketBudget(),
  ) {
    this.short = new Buckets(5_000, 12, budget);
    this.minutes = new Buckets(60_000, 60, budget);
    this.quarters = new Buckets(900_000, 96, budget);
    this.historyMinutes = new Buckets(60_000, 60, budget);
    this.historyQuarters = new Buckets(900_000, 96, budget);

    if (methods.length > 384) throw new Error("Diagnostics method budget exceeded");

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
        if (done) return;
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
        const elapsed = this.clock.monotonic() - started;
        this.#change(now + elapsed, id, (value) => {
          value.completed = addCount(value.completed);
          const safeCode = Number.isInteger(code) && code >= 0 && code <= 16 ? code : 2;
          value.codes[safeCode] = addCount(value.codes[safeCode]!);
          value.duration.record(elapsed);
          value.slow = addCount(value.slow, elapsed > 1000 ? 1n : 0n);
        });
      },
    };
  }

  #change(now: number, id: number, change: (value: import("@canopy/domain/diagnostics").Aggregate) => void) {
    for (const ring of [this.short, this.minutes, this.quarters]) {
      const value = ring.series(now, id);

      if (value) change(value);
    }
  }

  tick() {
    const mono = this.clock.monotonic();
    const utc = this.clock.utc();
    const elapsed = mono - this.#lastMono;

    // Sleep, event-loop stalls and wall-clock jumps are gaps, never invented observation time.
    if (elapsed >= 0 && elapsed <= 10_000 && Math.abs(utc - this.#lastUtc - elapsed) < 1000)
      for (const ring of [this.short, this.minutes, this.quarters]) ring.cover(this.#lastUtc, utc);
    this.#lastMono = mono;
    this.#lastUtc = utc;
    const before = this.budget.used;
    this.historyMinutes.expire(Math.floor(utc / 60_000) * 60_000 - 3_540_000);
    this.historyQuarters.expire(Math.floor(utc / 900_000) * 900_000 - 85_500_000);

    if (this.budget.used !== before) this.historyRevision++;
  }

  restore(process: ui.DiagnosticsProcess, at: number) {
    if (at >= this.startedAt || at < this.startedAt - 86_400_000) return;

    const safe = create(ui.DiagnosticsProcessSchema, {
      ...process,
      series: process.series.filter((value) => this.methods.has(value.methodId)),
    });

    // Historical sessions participate in reads, never in this session's persisted minute.
    if (at >= this.startedAt - 3_600_000) this.#restoreHistory(this.historyMinutes, safe, at);
    this.#restoreHistory(this.historyQuarters, safe, at);
    this.historyRevision++;
  }

  #restoreHistory(ring: Buckets, process: ui.DiagnosticsProcess, at: number) {
    // Restore may shed older detail, but must leave room for new RPCs and minute writes.
    const limit = Math.floor(this.budget.limit * 0.6);

    while (this.budget.used + ring.restoreBytes(process, at) > limit) {
      if (this.historyQuarters.evictOldest() || this.historyMinutes.evictOldest()) {
        this.budget.dropped++;
        continue;
      }

      this.budget.dropped += process.series.length;

      return;
    }

    ring.restore(process, at);
  }

  merge(process: ui.DiagnosticsProcess, at = this.clock.utc()) {
    for (const ring of [this.short, this.minutes, this.quarters]) ring.restore(process, at);
  }

  rollup(at: number) {
    const slot = this.minutes.slots.find((value) => value?.at === at);

    if (!slot) return;

    return create(ui.DiagnosticsProcessSchema, {
      processId: "gateway",
      session: this.session,
      sequence: BigInt(at),
      coverage: mergeCoverage(slot.coverage),
      series: [...slot.series].map(([id, value]) => value.snapshot(id)),
    });
  }
}

export type RpcObservation = NonNullable<ReturnType<RpcCollector["start"]>>;
