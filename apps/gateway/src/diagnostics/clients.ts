import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  CLIENT_SOURCES,
  clientMetricIds,
  clientCounter,
  threadWatchSource,
  type ClientSource,
} from "@canopy/domain/diagnostics";
import { Code, ConnectError } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import type { RpcCollector } from "./collector.ts";
import { cleanHistogram, validHistogram } from "./worker-report.ts";

/** One accepted client session of a sender and source: the newest sequence it delivered and when it was last seen. */
type Session = { sequence: bigint; last: number };

/**
 * Inactive sessions expire here. It exceeds the ±120 s freshness bound in both directions (240 s), so a batch
 * accepted before expiry is already stale and cannot be replayed afterwards.
 */
const SESSION_TTL_MS = 300_000;
const MAX_SESSIONS = 30;
const CHECKPOINT_BYTES = 384;

// Cover all senders, sessions and checkpoints on either side of the minute flush, even under RPC load.
const RESERVED_CHECKPOINTS = 2 * MAX_SESSIONS;
const METADATA_BYTES = 32 * 1024 + MAX_SESSIONS * (256 + 1024) + RESERVED_CHECKPOINTS * CHECKPOINT_BYTES;

/** Auth-bound senders are capped, and their numeric series use the original fixed collector budget. */
export class ClientDiagnostics {
  /** Keyed by the hash of sender, source and session; concurrent windows and reloads each hold their own slot. */
  readonly sessions = new Map<string, Session>();
  readonly rates = new Map<string, { at: number; bytes: number; last: number }>();
  readonly #checkpoints = new Map<number, Map<string, ui.DiagnosticsCheckpoint>>();
  readonly #restored = new Map<string, bigint>();
  readonly #metadataReserved: boolean;
  #checkpointCount = 0;
  constructor(
    readonly collector: RpcCollector,
    readonly epoch: () => string,
    readonly ready: () => boolean = () => true,
    readonly enabled = true,
  ) {
    // Fixed allowance includes restored hash checkpoints and empty collector metadata.
    this.#metadataReserved = !enabled || collector.budget.reserve(METADATA_BYTES);
  }

  submit(request: ui.SubmitDiagnosticsRequest, sender: string, allowBff: boolean, now = Date.now()) {
    if (!this.ready()) throw new ConnectError("Diagnostics are still restoring", Code.Unavailable);
    const size = toBinary(ui.SubmitDiagnosticsRequestSchema, request).length;
    const source = CLIENT_SOURCES.find((source) => source === request.source);

    if (
      !source ||
      (source === "bff" && !allowBff) ||
      request.samplingRate !== (source === "bff" ? 1 : 0.1) ||
      !/^[a-zA-Z0-9-]{16,64}$/.test(request.session) ||
      request.sequence < 1n ||
      size > (source === "bff" ? 32768 : 16384) ||
      request.endMs < request.startMs ||
      request.endMs - request.startMs > 60_000n ||
      Math.abs(now - Number(request.endMs)) > 120_000 ||
      request.measures.length > 24
    )
      throw new ConnectError("Diagnostics batch exceeds its schema or size limit", Code.InvalidArgument);
    const measures = validateMeasures(request, source, now);

    if (!this.enabled) return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });

    if (!this.#metadataReserved) throw new ConnectError("Diagnostics metadata budget reached", Code.ResourceExhausted);

    for (const [key, value] of this.sessions) if (now - value.last > SESSION_TTL_MS) this.sessions.delete(key);

    for (const [key, value] of this.rates) if (now - value.last > SESSION_TTL_MS) this.rates.delete(key);

    // The byte allowance is shared by everything an authenticated sender submits, whatever its source or session.
    let rate = this.rates.get(sender);

    if (!rate) {
      if (this.rates.size >= MAX_SESSIONS)
        throw new ConnectError("Diagnostics sender limit reached", Code.ResourceExhausted);
      rate = { at: now, bytes: 0, last: now };
      this.rates.set(sender, rate);
    }

    if (now - rate.at >= 60_000) {
      rate.at = now;
      rate.bytes = 0;
    }

    rate.bytes += size;
    rate.last = now;

    if (rate.bytes > 60 * 1024) throw new ConnectError("Diagnostics rate limit reached", Code.ResourceExhausted);

    if (request.epoch !== this.epoch()) return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });
    const session = createHash("sha256").update(`${sender}:${source}:${request.session}`).digest("hex");
    const known = this.sessions.get(session);

    if (known) known.last = now;

    if (request.sequence <= (known?.sequence ?? this.#restored.get(session) ?? 0n))
      return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });

    if (!known && this.sessions.size >= MAX_SESSIONS)
      throw new ConnectError("Diagnostics session limit reached", Code.ResourceExhausted);

    this.#remember(session, request.sequence, now);

    if (known) known.sequence = request.sequence;
    else this.sessions.set(session, { sequence: request.sequence, last: now });
    this.collector.mergeMeasures(measures, now);

    return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch(), accepted: true });
  }

  restore(values: readonly ui.DiagnosticsProcess[]) {
    for (const value of values)
      if (value.processId === "gateway" && /^[a-f0-9]{64}$/.test(value.session))
        this.#restored.set(value.session, value.sequence);

    while (this.#restored.size > 90) this.#restored.delete(this.#restored.keys().next().value!);
  }

  takeCheckpoints(at: number) {
    const values = this.#checkpoints.get(at);

    if (!values) return [];
    // Persistence now owns these checkpoints together with the minute, including retries.
    this.#release(at, values.size);

    return [...values.values()];
  }

  #release(at: number, size: number) {
    const borrowed = Math.max(0, this.#checkpointCount - RESERVED_CHECKPOINTS);
    this.collector.budget.used -= Math.min(size, borrowed) * CHECKPOINT_BYTES;
    this.#checkpointCount -= size;
    this.#checkpoints.delete(at);
  }

  #remember(session: string, sequence: bigint, now: number) {
    const minute = Math.floor(now / 60_000) * 60_000;

    for (const [at, values] of this.#checkpoints) if (at < minute - 3_540_000) this.#release(at, values.size);

    const values = this.#checkpoints.get(minute) ?? new Map<string, ui.DiagnosticsCheckpoint>();

    if (!values.has(session)) {
      if (this.#checkpointCount >= RESERVED_CHECKPOINTS && !this.collector.budget.reserve(CHECKPOINT_BYTES))
        throw new ConnectError("Diagnostics checkpoint budget reached", Code.ResourceExhausted);
      this.#checkpointCount++;
    }

    values.set(session, create(ui.DiagnosticsCheckpointSchema, { session, sequence }));
    this.#checkpoints.set(minute, values);
  }
}

function validateMeasures(request: ui.SubmitDiagnosticsRequest, source: ClientSource, now: number) {
  const allowed = clientMetricIds(source);
  const seen = new Set<number>();

  return request.measures.map((row) => {
    const histogram = row.histogram;
    const count = clientCounter(row.metricId);
    const offset = (row.metricId - 300) % 16;

    const limit = threadWatchSource(row.metricId)
      ? (row.metricId - 364) % 12 === 10
        ? 16
        : 0xffffffff
      : offset === 15
        ? 64 * 1024 * 1024
        : offset === 13
          ? 100
          : source === "bff"
            ? 604_800_000
            : 120_000;

    if (
      !allowed.has(row.metricId) ||
      seen.has(row.metricId) ||
      row.rpcMethodId ||
      row.events > 0xffff_ffffn ||
      row.errors ||
      row.weight ||
      row.weightedSum ||
      row.max ||
      row.last ||
      row.sampledAtMs < request.startMs ||
      row.sampledAtMs > request.endMs ||
      (count
        ? !!histogram
        : !histogram ||
          !validHistogram(histogram) ||
          histogram.max > limit ||
          histogram.counts.reduce((sum, value) => sum + value, 0n) !== row.events)
    )
      throw new ConnectError("Diagnostics metric is outside the registered schema", Code.InvalidArgument);
    seen.add(row.metricId);

    return create(ui.DiagnosticsMeasureAggregateSchema, {
      metricId: row.metricId,
      events: row.events,
      histogram: histogram && cleanHistogram(histogram),
      sampledAtMs: BigInt(now),
      incomplete: row.incomplete,
    });
  });
}
