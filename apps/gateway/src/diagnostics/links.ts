import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HeartbeatEcho, Histogram } from "@canopy/domain/diagnostics";
import { RpcCollector } from "./collector.ts";
import { rpcSnapshot } from "./snapshot.ts";
import type { BucketBudget, Slot } from "./buckets.ts";
import type { Connection } from "../computers/runtime-context.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";

const METHODS = ["rtt", "jitter", "heartbeat"].map((name, index) => ({
  id: index + 1,
  name,
  layer: "link",
  stream: false,
  interactive: false,
}));

export class LinkDiagnostics {
  restoring = false;
  readonly #pending: { value: ui.WorkerLinkDiagnostics; source: Connection | WorkerConnection | undefined }[] = [];
  readonly collector: RpcCollector;
  readonly echo = new HeartbeatEcho();
  lastHeartbeat = 0;
  #lastMono = 0;
  watermark = create(ui.DiagnosticsProcessSchema);
  readonly #watermarks = new Map<number, Map<string, ui.DiagnosticsCheckpoint>>();
  readonly #sessions = new Map<string, bigint>();
  #source: Connection | WorkerConnection | undefined;
  #sourceSession = "";

  constructor(
    readonly target: string,
    readonly kind: "worker" | "computer",
    readonly budget: BucketBudget,
  ) {
    this.collector = new RpcCollector(METHODS, undefined, budget);
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

  report(value: ui.WorkerLinkDiagnostics, source?: Connection | WorkerConnection) {
    if (source && source !== this.#source) {
      this.#source = source;
      this.#sourceSession = "";
    }

    if (source && this.#sourceSession && this.#sourceSession !== value.session) return false;

    if (value.session.length > 64 || value.sequence <= 0n || !/^[a-zA-Z0-9-]+$/.test(value.session)) return false;

    if (value.sequence <= (this.#sessions.get(value.session) ?? 0n)) return false;
    const histograms = [value.rtt, value.jitter];

    for (const histogram of histograms) {
      if (
        !histogram ||
        histogram.indices.length > 130 ||
        histogram.indices.length !== histogram.counts.length ||
        histogram.indices.some((index, at) => index > 129 || (at > 0 && index <= histogram.indices[at - 1]!)) ||
        histogram.counts.some((count) => count > 0xffff_ffffn) ||
        !Number.isFinite(histogram.sum) ||
        !Number.isFinite(histogram.max) ||
        (histogram.min !== undefined &&
          (!Number.isFinite(histogram.min) || histogram.min < 0 || histogram.min > histogram.max)) ||
        histogram.sum < 0 ||
        histogram.max < 0
      )
        return false;
    }

    if (value.endMs < value.startMs || value.endMs - value.startMs > 60_000n) return false;

    if (this.restoring) {
      if (this.#pending.length < 8 && this.budget.reserve(8192)) this.#pending.push({ value, source });
      else this.budget.dropped++;

      return true;
    }

    if (source) this.#sourceSession = value.session;
    this.collector.mergeHistogram(1, value.rtt!, value.echoTimeouts);
    this.collector.mergeHistogram(2, value.jitter!);
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

  resume() {
    this.restoring = false;

    for (const pending of this.#pending) {
      this.budget.used -= 8192;
      this.report(pending.value, pending.source);
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

  snapshot(minutes: number, name: string, supported: boolean, online: boolean, hourly?: Slot) {
    const snapshot = rpcSnapshot(this.collector, minutes, hourly);
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
    });
  }
}
