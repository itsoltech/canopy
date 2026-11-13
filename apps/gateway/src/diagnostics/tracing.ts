import { create, toBinary } from "@bufbuild/protobuf";
import { ui, computerLink } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";
import { actionQuery } from "./actions.ts";
import { linkedMessage } from "../computers/remote.ts";
import { TRACE_LIMITS, LEGACY_TRACE_SAMPLES, METRIC_DEFINITIONS, traceState } from "@canopy/domain/diagnostics";
import { DIAGNOSTICS_TRACE } from "../computers/capabilities.ts";

/** One computer, one process, one lease. No persistence, broadcast, automatic restart or onward routing. */
export class DiagnosticsTracing {
  #state = create(ui.DiagnosticsTraceStateSchema);
  #worker: WorkerConnection | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #deadline = 0;
  #actor = "owner";
  readonly #observed = new WeakSet<WorkerConnection>();
  constructor(readonly core: GatewayCore) {}

  state() {
    return create(ui.DiagnosticsTraceStateSchema, {
      ...this.#state,
      active: this.#state.active && performance.now() < this.#deadline && (!this.#worker || this.#worker.isOpen),
    });
  }

  async action(request: ui.DiagnosticsTraceRequest, exporting = false, actor = "owner") {
    if (this.#busy) throw new ConnectError("A tracing action is already running", Code.ResourceExhausted);
    this.#busy = true;

    try {
      const own = this.core.computers?.hello().nodeId ?? "local";

      if (request.computerId !== own) return await this.#remote(request, exporting, actor);

      if (!exporting && !["start", "stop"].includes(request.action))
        throw new ConnectError("Choose start or stop tracing", Code.InvalidArgument);

      if (exporting || request.action === "stop") {
        if (!request.leaseId || request.leaseId !== this.#state.leaseId || request.processId !== this.#state.processId)
          throw new ConnectError("Refresh this computer's tracing session", Code.FailedPrecondition);
      }

      if (exporting) {
        const result = this.#worker
          ? await this.#worker.tracing.call(create(ui.DiagnosticsTraceRequestSchema, { ...request, action: "export" }))
          : this.core.diagnostics.collector.tracing.export(request.leaseId, request.maxSamples || LEGACY_TRACE_SAMPLES);

        if (!result) throw new ConnectError("Tracing samples have expired", Code.NotFound);

        if (result.state?.leaseId !== request.leaseId || result.state.processId !== request.processId)
          throw new ConnectError("Tracing session changed", Code.DataLoss);
        this.#validate(result);
        await this.#audit("export", actor, result.spans.length);

        return result;
      }

      if (request.action === "stop") {
        await this.#audit("stop", actor);

        if (this.#worker) await this.#worker.tracing.call(request);
        else this.core.diagnostics.collector.tracing.stop(request.leaseId);
        this.#state.active = false;
        this.#purgeAfter();

        return create(ui.DiagnosticsTraceExportSchema, { state: this.state() });
      }

      return await this.#start(request, actor);
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.PermissionDenied)
        await this.#audit("denied", actor).catch(() => {});
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #start(request: ui.DiagnosticsTraceRequest, actor: string) {
    const minutes = request.minutes || 5;

    if (![1, 5, 10].includes(minutes)) throw new ConnectError("Choose 1, 5 or 10 minutes", Code.InvalidArgument);

    if (this.state().active) throw new ConnectError("Stop the current tracing session first", Code.ResourceExhausted);

    const worker = request.processId.startsWith("worker:")
      ? this.core.link.connections.get(request.processId.slice(7))
      : undefined;

    if (request.processId !== "gateway" && !worker?.hello.capabilities.includes(DIAGNOSTICS_TRACE))
      throw new ConnectError("Choose a connected process that supports tracing", Code.FailedPrecondition);
    const leaseId = crypto.randomUUID();

    const input = create(ui.DiagnosticsTraceRequestSchema, {
      computerId: request.computerId,
      processId: request.processId,
      action: "start",
      minutes,
      leaseId,
    });

    // Audit must commit before activation. Never retain database errors or their parameters.
    await this.#audit("start", actor, 0, leaseId, request.processId, minutes);
    clearTimeout(this.#timer);
    this.core.diagnostics.collector.tracing.clear();

    if (worker) {
      const result = await worker.tracing.call(input);

      if (!result.state?.active || result.state.leaseId !== leaseId)
        throw new ConnectError("Worker did not start tracing", Code.Unavailable);
    } else this.core.diagnostics.collector.tracing.start(leaseId, "gateway", minutes);
    this.#worker = worker;
    this.#actor = actor;

    if (worker && !this.#observed.has(worker)) {
      this.#observed.add(worker);
      void worker.closed.then(() => {
        if (this.#worker !== worker || !this.#state.active) return;
        this.#state.active = false;
        this.#worker = undefined;
        this.#purgeAfter();
        void this.#audit("cancel", this.#actor).catch(() => {});
      });
    }

    this.#deadline = performance.now() + minutes * 60_000;
    this.#state = create(ui.DiagnosticsTraceStateSchema, {
      active: true,
      leaseId,
      processId: request.processId,
      expiresAtMs: BigInt(Date.now() + minutes * 60_000),
    });
    this.#timer = setTimeout(() => {
      this.#state.active = false;
      this.core.diagnostics.collector.tracing.stop(leaseId);
      this.#purgeAfter();
      void this.#audit("expiry", actor).catch(() => {});
    }, minutes * 60_000);
    this.#timer.unref();

    return create(ui.DiagnosticsTraceExportSchema, { state: this.state() });
  }

  async #remote(request: ui.DiagnosticsTraceRequest, exporting: boolean, actor: string) {
    const host = this.core.computers;
    const peer = await host?.store.peer(request.computerId);

    if (
      !host ||
      !peer ||
      peer.via_node_id ||
      !host.canCall(peer.node_id) ||
      !host.capabilities(peer.node_id).includes(DIAGNOSTICS_TRACE)
    )
      throw new ConnectError("Choose a supported direct computer for tracing", Code.FailedPrecondition);

    const method = exporting
      ? computerLink.DiagnosticsService.method.exportHomeDiagnosticsTrace
      : computerLink.DiagnosticsService.method.controlHomeDiagnosticsTrace;

    for await (const message of host.remote(peer.node_id, method, request, AbortSignal.timeout(15_000))) {
      if (exporting) {
        const value = linkedMessage(ui.DiagnosticsTraceExportSchema, message);
        this.#validate(value);
        await this.#audit(
          "export_sent",
          actor,
          value.spans.length,
          value.state!.leaseId,
          value.state!.processId,
          0,
          peer.node_id,
        );

        return value;
      }

      const state = traceState(linkedMessage(ui.DiagnosticsTraceStateSchema, message));

      if (!state || state.processId !== request.processId)
        throw new ConnectError("Invalid tracing state", Code.DataLoss);
      await this.#audit(
        `${request.action}_sent`,
        actor,
        0,
        state.leaseId,
        state.processId,
        request.minutes,
        peer.node_id,
      );

      return create(ui.DiagnosticsTraceExportSchema, { state });
    }

    throw new ConnectError("Computer did not confirm tracing", Code.Unavailable);
  }

  #validate(value: ui.DiagnosticsTraceExport) {
    if (
      value.spans.length > TRACE_LIMITS.samples ||
      toBinary(ui.DiagnosticsTraceExportSchema, value).length > TRACE_LIMITS.bytes
    )
      throw new ConnectError("Tracing export exceeds its budget", Code.ResourceExhausted);

    for (const span of value.spans) {
      if (
        !this.#allowed(span) ||
        !/^[a-f0-9]{32}$/.test(span.traceId) ||
        !Number.isFinite(span.durationMs) ||
        span.durationMs < 0
      )
        throw new ConnectError("Invalid tracing sample", Code.DataLoss);
      span.$unknown = undefined;
      span.operationName =
        span.operation === "rpc"
          ? this.core.diagnostics.collector.methods.get(span.operationId)!.name
          : METRIC_DEFINITIONS.get(span.operationId)!.name;
    }

    value.state = traceState(value.state);

    if (!value.state) throw new ConnectError("Invalid tracing state", Code.DataLoss);
    value.$unknown = undefined;
  }

  #allowed(span: ui.DiagnosticsTraceSpan) {
    const metric = METRIC_DEFINITIONS.get(span.operationId);

    switch (span.operation) {
      case "rpc":
        return this.core.diagnostics.collector.methods.has(span.operationId);
      case "governor":
        return metric?.group === "governor" && metric.kind === "timing";
      case "ingest":
        return span.operationId === 22;
      case "pool":
        return span.operationId >= 1000 && span.operationId % 8 === 0 && metric?.group === "database";
      case "database":
        return span.operationId >= 1000 && metric?.group === "database" && metric.kind === "timing";
      default:
        return false;
    }
  }

  #purgeAfter() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.core.diagnostics.collector.tracing.clear();
      this.#worker = undefined;
      this.#state = create(ui.DiagnosticsTraceStateSchema);
    }, 600_000);
    this.#timer.unref();
  }

  async #audit(
    result: string,
    actor: string,
    count = 0,
    lease = this.#state.leaseId,
    process = this.#state.processId,
    minutes = 0,
    home = this.core.computers?.hello().nodeId ?? "local",
  ) {
    await actionQuery(
      this.core,
      `INSERT INTO audit_log(id,actor_user_id,action,target_type,details)
      VALUES(gen_random_uuid(),$1::uuid,'diagnostics.tracing','computer',jsonb_build_object('result',$2::text,'lease',$3::text,'process',$4::text,'actor',$5::text,'samples',$6::int,'minutes',$7::int,'home',$8::text))`,
      [this.core.diagnostics.options.userId, result, lease, process, actor, String(count), String(minutes), home],
    );
  }

  async close() {
    clearTimeout(this.#timer);

    if (this.#state.active) {
      if (this.#worker)
        await this.#worker.tracing
          .call(
            create(ui.DiagnosticsTraceRequestSchema, {
              action: "stop",
              leaseId: this.#state.leaseId,
              processId: this.#state.processId,
            }),
          )
          .catch(() => {});
      await this.#audit("cancel", "shutdown").catch(() => {});
    }

    this.#state = create(ui.DiagnosticsTraceStateSchema);
    this.#worker = undefined;
    this.core.diagnostics.collector.tracing.clear();
  }
}
