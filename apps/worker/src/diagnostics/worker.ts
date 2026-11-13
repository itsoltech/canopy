import { stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { WorkerMeasurements } from "./measurements.ts";
import { WorkerTurns } from "./turns.ts";
import { gitMetric, METRIC_DEFINITIONS, type GitFamily } from "@canopy/domain/diagnostics";
import type { JournalStatistics } from "../journal/statistics.ts";

export class WorkerDiagnostics {
  enabled = false;
  readonly measurements = new WorkerMeasurements();
  readonly turns = new WorkerTurns(this);
  readonly #sent = new Map<string, bigint>();
  #cpu = process.cpuUsage();
  #at = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #diskAt = -Infinity;
  #diskBusy = false;
  constructor(
    readonly monotonic = () => performance.now(),
    readonly utc = () => Date.now(),
  ) {}

  record(id: number, value: number, error = false, weight = 0) {
    if (this.enabled)
      this.measurements.record(
        id,
        value,
        METRIC_DEFINITIONS.get(id)?.kind === "counter" ? 0 : this.utc(),
        error,
        weight,
      );
  }

  start(dataDir: string, journal?: () => JournalStatistics) {
    if (this.#timer) return;
    this.enabled = true;
    this.#at = this.monotonic();
    this.#cpu = process.cpuUsage();
    this.#timer = setInterval(() => this.sample(dataDir, journal), 5000);
    this.#timer.unref();
  }

  sample(dataDir: string, journal?: () => JournalStatistics) {
    if (!this.enabled) return;
    const now = this.monotonic();
    const elapsed = now - this.#at;
    const cpu = process.cpuUsage(this.#cpu);
    this.#cpu = process.cpuUsage();
    this.#at = now;
    const weight = elapsed > 0 && elapsed <= 10_000 ? elapsed : 0;
    const memory = process.memoryUsage();

    if (weight) this.record(2, (cpu.user + cpu.system) / elapsed / 10, false, weight);
    this.record(3, memory.rss, false, weight);
    this.record(4, memory.heapUsed, false, weight);
    this.record(5, memory.heapTotal, false, weight);
    this.record(6, process.uptime(), false, weight);

    if (journal) {
      try {
        const value = journal();
        this.record(100, value.events, false, weight);
        this.record(101, value.bytes, false, weight);
        this.record(102, value.oldest ? Math.max(0, this.utc() - value.oldest) : 0, false, weight);
      } catch {
        /* A failed sample must never affect ACK or delivery. */
      }
    }

    if (!this.#diskBusy && now - this.#diskAt >= 60_000) {
      this.#diskAt = now;
      this.#diskBusy = true;
      void this.#disk(dataDir).finally(() => {
        this.#diskBusy = false;
      });
    }
  }

  async #disk(dataDir: string) {
    try {
      const fs = await statfs(dataDir);

      const files = await Promise.all(
        ["journal.db", "journal.db-wal", "journal.db-shm"].map((name) =>
          stat(join(dataDir, name)).catch(() => undefined),
        ),
      );

      this.record(120, fs.bavail * fs.bsize);
      this.record(121, fs.blocks * fs.bsize);
      this.record(
        122,
        files.reduce((sum, file) => sum + (file?.size ?? 0), 0),
      );
    } catch {
      /* Unsupported or inaccessible storage stays unmeasured. */
    }
  }

  sent(thread: string, sequence: bigint, replay = false) {
    if (!this.enabled || !thread || sequence <= 0n) return;
    this.record(103, 1);
    const previous = this.#sent.get(thread);

    if (previous !== undefined && sequence <= previous) this.record(104, 1);
    else if (previous === undefined && replay) this.record(105, 1);

    if (thread.length > 80) {
      this.measurements.dropped++;

      return;
    }

    if (!this.#sent.has(thread) && this.#sent.size >= 256) {
      this.#sent.delete(this.#sent.keys().next().value!);
      this.measurements.dropped++;
    }

    this.#sent.set(thread, previous && previous > sequence ? previous : sequence);
  }

  git(family: GitFamily) {
    const queued = this.monotonic();
    let started: number | undefined;

    return {
      start: () => {
        started = this.monotonic();
        this.record(gitMetric(family, "wait"), started - queued);
      },
      end: (error: boolean) => {
        if (started !== undefined) this.record(gitMetric(family, "execution"), this.monotonic() - started, error);
      },
    };
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.enabled = false;
    this.turns.active.clear();
    this.#sent.clear();
    this.measurements.reset();
  }
}

export const workerDiagnostics = new WorkerDiagnostics();
