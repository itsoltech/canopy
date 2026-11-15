import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HeartbeatEcho, Histogram, sanitizeStorage } from "@canopy/domain/diagnostics";
import { RpcCollector } from "./collector.ts";
import { rpcSnapshot } from "./snapshot.ts";
import type { BucketBudget, Slot } from "./buckets.ts";
import type { Connection } from "../computers/runtime-context.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";
import { workerMeasures, workerStorage, cleanHistogram, validHistogram, reportBytes } from "./worker-report.ts";

const METHODS = ["rtt", "jitter", "heartbeat"].map((name, index) => ({
  id: index + 1,
  name,
  layer: "link",
  stream: false,
  interactive: false,
}));

export class LinkDiagnostics {
  restoring = false;
  readonly #pending: {
    value: ui.WorkerLinkDiagnostics;
    source: Connection | WorkerConnection | undefined;
    at: number;
    bytes: number;
  }[] = [];
  readonly collector: RpcCollector;
  readonly echo = new HeartbeatEcho();
  lastHeartbeat = 0;
  #lastMono = 0;
  watermark = create(ui.DiagnosticsProcessSchema);
  readonly #watermarks = new Map<number, Map<string, ui.DiagnosticsCheckpoint>>();
  readonly #sessions = new Map<string, bigint>();
  #source: Connection | WorkerConnection | undefined;
  #sourceSession = "";
  measuresSupported = false;
  reportedDrops = 0n;
  activeWatches = 0;
  resetAt = 0;
  #storage: ui.DiagnosticsStorage | undefined;
  #storageSession = "";
  #storageAt = 0n;
  #storageReceived = 0;

  reset() {
    this.collector.reset();
    this.resetAt = Date.now();

    for (const pending of this.#pending) this.budget.used -= pending.bytes;
    this.#pending.length = 0;
  }

  constructor(
    readonly target: string,
    readonly kind: "worker" | "computer",
    readonly budget: BucketBudget,
  ) {
    this.collector = new RpcCollector(METHODS, undefined, budget);

    if (kind === "worker") this.collector.freshnessMs = 90_000;
  }

  heartbeat() {
    const now = performance.now();

    if (this.#lastMono) {
      const histogram = new Histogram();
      histogram.record(now - this.#lastMono);
      this.collector.mergeHistogram(3, histogram);
    }

    this.#lastMono = now;
    this.lastHeartbeat = Date.now();
  }

  restoreWatermark(value: ui.DiagnosticsProcess) {
    const previous = this.#sessions.get(value.session) ?? 0n;
    this.#sessions.set(value.session, previous > value.sequence ? previous : value.sequence);
    this.watermark = value;

    while (this.#sessions.size > 2) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  report(value: ui.WorkerLinkDiagnostics, source?: Connection | WorkerConnection, at = Date.now()) {
    const measures = workerMeasures(value);

    if (!measures) return false;
    value = create(ui.WorkerLinkDiagnosticsSchema, {
      session: value.session,
      sequence: value.sequence,
      startMs: value.startMs,
      endMs: value.endMs,
      rtt: value.rtt && cleanHistogram(value.rtt),
      jitter: value.jitter && cleanHistogram(value.jitter),
      echoTimeouts: value.echoTimeouts,
      measures,
      workerMeasuresSupported: value.workerMeasuresSupported,
      droppedSamples: value.droppedSamples,
      storage: this.kind === "worker" ? workerStorage(value) : undefined,
    });

    if (source && source !== this.#source) {
      this.#source = source;
      this.#sourceSession = "";
    }

    if (source && this.#sourceSession && this.#sourceSession !== value.session) return false;

    if (value.session.length > 64 || value.sequence <= 0n || !/^[a-zA-Z0-9-]+$/.test(value.session)) return false;

    if (value.sequence <= (this.#sessions.get(value.session) ?? 0n)) return false;
    const histograms = [value.rtt, value.jitter];

    for (const histogram of histograms) {
      if (!histogram || !validHistogram(histogram)) return false;
    }

    if (value.endMs < value.startMs || value.endMs - value.startMs > 60_000n) return false;

    if (this.restoring) {
      const bytes = reportBytes(value);

      if (this.#pending.length < 8 && this.budget.reserve(bytes)) this.#pending.push({ value, source, at, bytes });
      else this.budget.drop("collection", at);

      return true;
    }

    if (Number(value.startMs) < this.resetAt) {
      // A batch straddling a durable baseline cannot re-import old observations, even after restart.
      this.restoreWatermark(
        create(ui.DiagnosticsProcessSchema, {
          processId: `${this.kind}:${this.target}`,
          session: value.session,
          sequence: value.sequence,
        }),
      );
      this.budget.drop("collection", at);

      return true;
    }

    if (source) this.#sourceSession = value.session;
    this.collector.mergeHistogram(1, value.rtt!, value.echoTimeouts);
    this.collector.mergeHistogram(2, value.jitter!);

    for (const row of measures) row.sampledAtMs = BigInt(at - Number(value.endMs - row.sampledAtMs));
    this.collector.mergeMeasures(measures, at);
    this.measuresSupported = value.workerMeasuresSupported;
    this.reportedDrops = value.droppedSamples;
    this.#acceptStorage(value, at);
    this.watermark = create(ui.DiagnosticsProcessSchema, {
      processId: `${this.kind}:${this.target}`,
      session: value.session,
      sequence: value.sequence,
    });
    this.restoreWatermark(this.watermark);
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const checkpoints = this.#watermarks.get(minute) ?? new Map<string, ui.DiagnosticsCheckpoint>();
    checkpoints.set(
      value.session,
      create(ui.DiagnosticsCheckpointSchema, { session: value.session, sequence: value.sequence }),
    );

    if (checkpoints.size > 2) checkpoints.delete(checkpoints.keys().next().value!);
    this.#watermarks.set(minute, checkpoints);

    for (const at of this.#watermarks.keys()) if (at < minute - 3_600_000) this.#watermarks.delete(at);

    return true;
  }

  #acceptStorage(value: ui.WorkerLinkDiagnostics, at: number) {
    const storage = value.storage;

    if (!storage) return;

    if (this.#storageSession === value.session && storage.sampledAtMs <= this.#storageAt) return;
    const sampledAt = storage.sampledAtMs ? BigInt(at) - (value.endMs - storage.sampledAtMs) : 0n;

    if (sampledAt < 0n || (storage.sampledAtMs > 0n && sampledAt === 0n)) return;

    if (this.#storage && sampledAt <= this.#storage.sampledAtMs) return;
    this.#storageAt = storage.sampledAtMs;
    this.#storageSession = value.session;
    this.#storageReceived = performance.now();
    this.#storage = create(ui.DiagnosticsStorageSchema, {
      ...storage,
      sampledAtMs: sampledAt,
      sampleAgeMs: sampledAt ? Math.max(0, at - Number(sampledAt)) : 0,
    });
  }

  restoreStorage(value: ui.DiagnosticsStorage | undefined) {
    const storage = sanitizeStorage(value);

    if (!storage || !["worker", "desktop"].includes(storage.component) || !storage.sampledAtMs) return;

    if (this.#storage && storage.sampledAtMs <= this.#storage.sampledAtMs) return;
    const now = Date.now();
    const age = Math.max(storage.sampleAgeMs, now - Number(storage.sampledAtMs));
    this.#storage = create(ui.DiagnosticsStorageSchema, {
      ...storage,
      sampledAtMs: storage.sampledAtMs > BigInt(now) ? BigInt(Math.max(1, Math.trunc(now - age))) : storage.sampledAtMs,
      sampleAgeMs: age,
    });
    this.#storageReceived = performance.now();
  }

  storageSnapshot() {
    return (
      this.#storage &&
      create(ui.DiagnosticsStorageSchema, {
        ...this.#storage,
        sampleAgeMs: this.#storage.sampledAtMs
          ? Math.max(
              this.#storage.sampleAgeMs + Math.max(0, performance.now() - this.#storageReceived),
              Date.now() - Number(this.#storage.sampledAtMs),
            )
          : 0,
      })
    );
  }

  resume() {
    this.restoring = false;

    for (const pending of this.#pending) {
      this.budget.used -= pending.bytes;
      this.report(pending.value, pending.source, pending.at);
    }

    this.#pending.length = 0;
  }

  rollup(at: number) {
    const value = this.collector.rollup(at);

    if (!value) return;
    const checkpoints = this.#watermarks.get(at);

    return create(ui.DiagnosticsProcessSchema, {
      ...value,
      processId: `${this.kind}:${this.target}`,
      checkpoints: [...(checkpoints?.values() ?? [])],
    });
  }

  snapshot(minutes: number, name: string, supported: boolean, online: boolean, hourly?: Slot, overviewOnly = false) {
    const snapshot = rpcSnapshot(this.collector, minutes, hourly, overviewOnly);
    const find = (method: string) => snapshot.calls.find((call) => call.method === method)?.durationMs;

    return create(ui.DiagnosticsLinkSchema, {
      targetId: this.target,
      kind: this.kind,
      name,
      supported,
      online,
      rttMs: find("rtt"),
      jitterMs: find("jitter"),
      heartbeatIntervalMs: find("heartbeat"),
      heartbeatAgeMs: this.lastHeartbeat ? Date.now() - this.lastHeartbeat : 0,
      echoTimeouts: snapshot.calls.find((call) => call.method === "rtt")?.codes[4] ?? 0n,
      measures: snapshot.gatewayMeasures,
      measuresSupported: this.measuresSupported || snapshot.gatewayMeasures.length > 0,
      droppedSamples: this.reportedDrops + snapshot.droppedSamples,
      storage: this.storageSnapshot(),
    });
  }
}
