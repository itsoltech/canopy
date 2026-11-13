import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { CLIENT_SOURCES, clientMetricIds, clientCounter, type ClientSource } from "@canopy/domain/diagnostics";
import { Code, ConnectError } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import type { RpcCollector } from "./collector.ts";
import { cleanHistogram, validHistogram } from "./worker-report.ts";

type Sender = { at: number; bytes: number; session: string; sequence: bigint; retired: string[]; last: number };

/** Auth-bound senders are capped, and their numeric series use the original fixed collector budget. */
export class ClientDiagnostics {
  readonly senders = new Map<string, Sender>();
  readonly rates = new Map<string, { at: number; bytes: number; last: number }>();
  readonly #checkpoints = new Map<number, Map<string, ui.DiagnosticsCheckpoint>>();
  readonly #restored = new Map<string, bigint>();
  readonly #metadataReserved: boolean;
  constructor(
    readonly collector: RpcCollector,
    readonly epoch: () => string,
    readonly ready: () => boolean = () => true,
    readonly enabled = true,
  ) {
    // Fixed allowance includes restored hash checkpoints and empty collector metadata.
    this.#metadataReserved = !enabled || collector.budget.reserve(32 * 1024);
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
      request.measures.length > 12
    )
      throw new ConnectError("Diagnostics batch exceeds its schema or size limit", Code.InvalidArgument);
    const measures = validateMeasures(request, source, now);

    if (!this.enabled) return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });

    if (!this.#metadataReserved) throw new ConnectError("Diagnostics metadata budget reached", Code.ResourceExhausted);

    for (const [key, value] of this.senders)
      if (now - value.last > 300_000) {
        this.senders.delete(key);
        this.collector.budget.used -= 1024;
      }

    for (const [key, value] of this.rates)
      if (now - value.last > 300_000) {
        this.rates.delete(key);
        this.collector.budget.used -= 256;
      }

    let rate = this.rates.get(sender);

    if (!rate) {
      if (this.rates.size >= 30 || !this.collector.budget.reserve(256))
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
    const key = `${sender}:${source}`;
    const session = createHash("sha256").update(`${key}:${request.session}`).digest("hex");
    let state = this.senders.get(key);

    if (!state) {
      if (this.senders.size >= 30 || !this.collector.budget.reserve(1024))
        throw new ConnectError("Diagnostics sender limit reached", Code.ResourceExhausted);
      state = { at: now, bytes: 0, session: request.session, sequence: 0n, retired: [], last: now };
      this.senders.set(key, state);
    }

    if (now - state.at >= 60_000) {
      state.at = now;
      state.bytes = 0;
    }

    state.bytes += size;
    state.last = now;

    if (request.epoch !== this.epoch()) return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });

    if (
      request.sequence <= (this.#restored.get(session) ?? 0n) ||
      state.retired.includes(request.session) ||
      (state.session === request.session && request.sequence <= state.sequence)
    )
      return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch() });

    if (state.session !== request.session) {
      // A sender may restart twice within its five-minute lease; never evict a retired session and accept replay.
      if (state.retired.length >= 2)
        throw new ConnectError("Diagnostics session limit reached", Code.ResourceExhausted);
      state.retired.push(state.session);
      state.session = request.session;
    }

    this.#remember(session, request.sequence, now);
    state.sequence = request.sequence;
    this.collector.mergeMeasures(measures, now);

    return create(ui.DiagnosticsReceiptSchema, { epoch: this.epoch(), accepted: true });
  }

  restore(values: readonly ui.DiagnosticsProcess[]) {
    for (const value of values)
      if (value.processId === "gateway" && /^[a-f0-9]{64}$/.test(value.session))
        this.#restored.set(value.session, value.sequence);

    while (this.#restored.size > 90) this.#restored.delete(this.#restored.keys().next().value!);
  }

  rollup(process: ui.DiagnosticsProcess, at: number) {
    process.checkpoints.push(...(this.#checkpoints.get(at)?.values() ?? []));

    return process;
  }

  #remember(session: string, sequence: bigint, now: number) {
    const minute = Math.floor(now / 60_000) * 60_000;

    for (const [at, values] of this.#checkpoints)
      if (at < minute - 3_540_000) {
        this.collector.budget.used -= values.size * 384;
        this.#checkpoints.delete(at);
      }

    const values = this.#checkpoints.get(minute) ?? new Map<string, ui.DiagnosticsCheckpoint>();

    if (!values.has(session) && !this.collector.budget.reserve(384))
      throw new ConnectError("Diagnostics checkpoint budget reached", Code.ResourceExhausted);
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
    const limit = offset === 15 ? 64 * 1024 * 1024 : offset === 13 ? 100 : source === "bff" ? 604_800_000 : 120_000;

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
