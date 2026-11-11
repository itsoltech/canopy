import { create } from "@bufbuild/protobuf";
import { ui, type WorkerMessage } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";
import { RpcCollector } from "./collector.ts";
import { RPC_METHODS, LINKED_METHODS, COMMAND_METHODS, MAX_METHODS, methodId } from "./registry.ts";
import { diagnosticsInterceptor } from "./interceptor.ts";
import { rpcSnapshot, windowMinutes } from "./snapshot.ts";
import { DiagnosticsStore } from "./store.ts";
import { DiagnosticsPersistence } from "./persistence.ts";
import { DiagnosticsPeers } from "./peers.ts";
import { Findings } from "./findings.ts";
import { LinkDiagnostics } from "./links.ts";
import { BucketBudget } from "./buckets.ts";
import { callKey, sortCalls, diagnosticsSorts } from "@canopy/domain/diagnostics";
import { diagnosticsResponse } from "./response.ts";
import { DiagnosticsHistory } from "./history.ts";
import { ProcessDiagnostics } from "./process.ts";
import { IngestDiagnostics } from "./ingest.ts";
import { WorkerCatalog } from "./worker-catalog.ts";

const METHOD_KEYS = new Set(
  [...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS].map((method) => `${method.layer}:${method.name}`),
);

export class Diagnostics {
  readonly collector = new RpcCollector([...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS]);
  readonly interceptor = diagnosticsInterceptor(this.collector);
  readonly resources: ProcessDiagnostics;
  readonly ingest = new IngestDiagnostics(this.collector);
  readonly findings = new Findings();
  readonly links = new Map<string, LinkDiagnostics>();
  readonly peers: DiagnosticsPeers;
  readonly linkBudget = new BucketBudget(2 * 1024 * 1024);
  persistence: DiagnosticsPersistence | undefined;
  history: DiagnosticsHistory | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #minute = 0;
  #unsubscribe: (() => void) | undefined;
  #snapshots = new Map<
    number,
    {
      at: number;
      value: ReturnType<typeof rpcSnapshot>;
      restored: number;
      historical: number | undefined;
      details: boolean;
    }
  >();
  readonly workers: WorkerCatalog;
  #cacheSavedAt = 0;

  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
  ) {
    this.collector.enabled = options.diagnosticsEnabled ?? true;
    this.collector.gatewayEnabled = options.gatewayDiagnosticsEnabled ?? true;

    // Hub's fixed scalar fan-out accumulator shares the existing collector allowance.
    if (this.collector.enabled && this.collector.gatewayEnabled) this.collector.budget.reserve(256);
    this.resources = new ProcessDiagnostics(this.collector, options.runtime);
    this.peers = new DiagnosticsPeers(core);
    this.workers = new WorkerCatalog(options);
  }

  async start() {
    if (!this.collector.enabled) return;

    if (this.#timer) return;
    this.resources.start();
    const computer = this.core.computers?.hello().nodeId ?? "local";
    this.persistence = new DiagnosticsPersistence(
      new DiagnosticsStore(this.options.runtime, this.options.userId, computer),
      this.collector,
      {
        ready: () => {
          for (const link of this.links.values()) link.resume();
        },
        state: () => ({
          findings: [...this.findings.states.values()],
          watermarks: [],
          peerOverviews: this.#peerState(),
        }),
        saved: (state) => {
          if (state.peerOverviews.length) this.#cacheSavedAt = Date.now();
        },
        restore: (state) => {
          this.findings.restore(state.findings);
          this.peers.restore(state.peerOverviews);

          for (const watermark of state.watermarks) {
            const [kind, target] = watermark.processId.split(":");

            if (target && (kind === "worker" || kind === "computer")) {
              const link = this.link(target, kind);

              link?.restoreWatermark(watermark);
            }
          }
        },
        restoreProcess: (process, at) => {
          const [kind, target] = process.processId.split(":");

          if (target && (kind === "worker" || kind === "computer"))
            this.link(target, kind)?.collector.restore(process, at);
        },
        processes: (at) =>
          [...this.links.values()].flatMap((link) => {
            const value = link.rollup(at);

            return value ? [value] : [];
          }),
      },
    );
    this.#unsubscribe = this.core.computers?.subscribe((change) =>
      this.peers.invalidate(change.nodeId, change.removed),
    );
    this.#timer = setInterval(() => this.tick(), 5000);
    this.#timer.unref();
    void this.peers.catalog().catch(() => {});
    void this.workers.refresh();
    this.history = new DiagnosticsHistory(this.persistence.store, (process, id) =>
      process === "gateway" ? this.collector.methods.has(id) : this.links.has(process) && id >= 1 && id <= 3,
    );

    for (const link of this.links.values()) link.restoring = true;
    void this.persistence.start();
  }

  link(target: string, kind: "worker" | "computer") {
    const key = `${kind}:${target}`;
    let value = this.links.get(key);

    if (!value && this.links.size < 16) {
      value = new LinkDiagnostics(target, kind, this.linkBudget);
      value.restoring = this.persistence ? !this.persistence.ready : false;
      this.links.set(key, value);
    }

    return value;
  }

  workerMessage(connection: WorkerConnection, message: WorkerMessage) {
    if (!this.collector.enabled) return message.payload.case === "diagnostics";

    if (message.payload.case === "threadEvent") this.ingest.receive(connection, message.payload.value);
    const link = this.link(connection.workerId, "worker");

    if (message.payload.case === "heartbeat") link?.heartbeat();

    if (message.payload.case === "diagnostics") {
      if (
        !(this.options.workerDiagnosticsEnabled ?? true) ||
        !connection.hello.capabilities.includes("worker_diagnostics_v1")
      ) {
        message.payload.value.measures = [];
        message.payload.value.workerMeasuresSupported = false;
      }

      if (connection.hello.capabilities.includes("diagnostics_v1")) link?.report(message.payload.value, connection);

      return true;
    }

    return false;
  }

  sync(target: string, id: number, value: number) {
    if (this.collector.enabled && (this.options.workerDiagnosticsEnabled ?? true))
      this.link(target, "computer")?.collector.measure(id, value);
  }

  syncWatch(target: string, delta: number) {
    if (!this.collector.enabled || !(this.options.workerDiagnosticsEnabled ?? true)) return;
    const link = this.link(target, "computer");

    if (!link) return;
    link.activeWatches = Math.max(0, link.activeWatches + delta);
    link.collector.measure(220, link.activeWatches);
  }

  command(kind: string) {
    return this.collector.start(methodId(`command:${kind}`));
  }

  tick() {
    this.collector.tick();
    const weight = this.resources.sample();
    this.ingest.sample(weight);
    const hub = this.core.hub.snapshot();
    this.collector.measure(28, hub.threads, false, 0, weight);
    this.collector.measure(29, hub.overview, false, 0, weight);
    this.collector.measure(40, this.core.computers?.diagnosticsWatches() ?? 0, false, 0, weight);
    this.collector.measure(34, hub.peakItems);
    this.collector.measure(34, hub.items, false, 0, weight);
    this.collector.measure(35, hub.peakBytes);
    this.collector.measure(35, hub.bytes, false, 0, weight);

    for (const link of this.links.values()) {
      link.collector.tick();

      if (link.kind === "computer" && (this.options.workerDiagnosticsEnabled ?? true))
        link.collector.measure(220, link.activeWatches, false, 0, weight);
    }

    void this.peers.catalog().catch(() => {});
    void this.peers.tick();
    void this.workers.refresh();
    const minute = Math.floor(Date.now() / 60_000);

    if (minute !== this.#minute) {
      this.#minute = minute;
      this.findings.evaluate(
        this.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: 15, limit: MAX_METHODS }), true),
        this.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: 1, limit: MAX_METHODS }), true),
      );
      void this.persistence?.flush();
    }
  }

  local(request: ui.ComputerDiagnosticsRequest, internal = false) {
    const minutes = windowMinutes(request.windowMinutes);

    if (
      (request.sortBy && !diagnosticsSorts.some((sort) => sort.value === request.sortBy)) ||
      (request.callKind && !["unary", "stream"].includes(request.callKind)) ||
      request.methodKeys.length > 32 ||
      request.methodKeys.some((key) => !METHOD_KEYS.has(key))
    )
      throw new ConnectError("Choose an available call view", Code.InvalidArgument);

    if (request.offset > MAX_METHODS || (!internal && request.limit > 32))
      throw new ConnectError("Diagnostics page exceeds budget", Code.InvalidArgument);
    let cached = this.#snapshots.get(minutes);
    const now = this.collector.clock.utc();

    if (
      !cached ||
      (!request.overviewOnly && !cached.details) ||
      now - cached.at >= 5000 ||
      cached.restored !== this.collector.historyRevision ||
      (minutes === 1440 && cached.historical !== this.history?.revision)
    ) {
      cached = {
        at: now,
        restored: this.collector.historyRevision,
        historical: this.history?.revision,
        details: !request.overviewOnly,
        value: rpcSnapshot(
          this.collector,
          minutes,
          minutes === 1440 ? this.history?.values.get("gateway") : undefined,
          request.overviewOnly,
        ),
      };
      this.#snapshots.set(minutes, cached);
    }

    const own = cached.value;
    const limit = request.limit || 32;

    const calls = sortCalls(
      own.calls.filter((call) => !request.callKind || call.stream === (request.callKind === "stream")),
      request.sortBy || "method",
    );

    const page = request.methodKeys.length
      ? request.methodKeys.flatMap((key) => {
          const call = calls.find((value) => callKey(value) === key);

          return call ? [call] : [];
        })
      : calls.slice(request.offset, request.offset + limit);

    const revision = `${this.collector.session}:${Math.floor(cached.at / 5000)}:${minutes}:${request.offset}:${request.sortBy}:${request.callKind}:${request.methodKeys.join(",")}:${Number(request.overviewOnly)}`;
    const computer = this.core.computers;
    const links = this.#links(minutes, request.overviewOnly);

    const result = create(ui.ComputerDiagnosticsSchema, {
      ...own,
      calls: request.overviewOnly ? [] : page,
      computerId: computer?.hello().nodeId ?? "local",
      name: computer?.hello().name ?? "This computer",
      appVersion: CANOPY_VERSION,
      status: "online",
      processSession: this.collector.session,
      epoch: this.persistence?.epoch ?? this.collector.session,
      sampledAtMs: BigInt(cached.at),
      sampleAgeMs: Math.max(0, now - cached.at),
      restoring: this.persistence?.restoring ?? false,
      persistedThroughMs: BigInt(this.persistence?.persistedThrough ?? 0),
      pendingMinutes: this.persistence?.pending.size ?? 0,
      persistenceStatus: this.persistence?.status ?? "not_started",
      links: links.values,
      findings: this.findings.snapshot(),
      totalMethods: calls.length,
      nextOffset: request.offset + limit < calls.length ? request.offset + limit : 0,
      revision,
      notModified: request.revision === revision,
      droppedSamples: BigInt(
        this.collector.budget.dropped +
          this.linkBudget.dropped +
          links.dropped +
          (minutes === 1440 ? (this.history?.dropped ?? 0) : 0),
      ),
      detailsAvailable: !request.overviewOnly,
      windowMinutes: minutes,
      gatewayMeasuresSupported: this.collector.gatewayEnabled,
      gatewayMeasures: request.overviewOnly
        ? own.gatewayMeasures.filter((value) => value.metricId === 2)
        : own.gatewayMeasures,
      database: request.overviewOnly ? [] : own.database,
    });

    return internal ? result : diagnosticsResponse(result, request);
  }

  #links(minutes: number, overviewOnly = false) {
    const result: ui.DiagnosticsLink[] = [];
    let dropped = Number(this.workers.limited);

    const workers = new Map(this.workers.values.map((worker) => [worker.id, worker]));

    for (const connection of this.core.link.connections.values())
      workers.set(connection.workerId, {
        id: connection.workerId,
        name: workers.get(connection.workerId)?.name ?? "Worker",
        supported: connection.hello.capabilities.includes("diagnostics_v1"),
        measured: connection.hello.capabilities.includes("worker_diagnostics_v1"),
      });

    for (const worker of workers.values()) {
      const link = this.link(worker.id, "worker");

      if (link && worker.measured && (this.options.workerDiagnosticsEnabled ?? true)) link.measuresSupported = true;

      if (link)
        result.push(
          link.snapshot(
            minutes,
            worker.name,
            worker.supported,
            this.core.link.connections.has(worker.id),
            minutes === 1440 ? this.history?.values.get(`worker:${worker.id}`) : undefined,
            overviewOnly,
          ),
        );
      else {
        dropped++;
        result.push(
          create(ui.DiagnosticsLinkSchema, {
            targetId: worker.id,
            kind: "worker",
            name: worker.name,
            supported: worker.supported,
            online: this.core.link.connections.has(worker.id),
          }),
        );
      }
    }

    for (const peer of this.peers.peers) {
      const link = this.link(peer.node_id, "computer");

      if (link)
        result.push(
          link.snapshot(
            minutes,
            peer.display_name || peer.name,
            peer.capabilities.includes("diagnostics_v1"),
            this.core.computers?.canCall(peer.node_id) ?? false,
            minutes === 1440 ? this.history?.values.get(`computer:${peer.node_id}`) : undefined,
            overviewOnly,
          ),
        );
      else {
        dropped++;
        result.push(
          create(ui.DiagnosticsLinkSchema, {
            targetId: peer.node_id,
            kind: "computer",
            name: peer.display_name || peer.name,
            supported: peer.capabilities.includes("diagnostics_v1"),
            online: this.core.computers?.canCall(peer.node_id) ?? false,
          }),
        );
      }
    }

    return { values: result, dropped };
  }

  async overview(request: ui.DiagnosticsRequest) {
    const minutes = windowMinutes(request.windowMinutes);
    await this.peers.catalog();

    return create(ui.DiagnosticsSnapshotSchema, {
      computers: [
        await this.read(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: minutes, overviewOnly: true })),
        ...this.peers.peers.map((peer) =>
          this.peers.view(
            peer,
            create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true, windowMinutes: minutes }),
          ),
        ),
      ],
    });
  }

  async computer(request: ui.ComputerDiagnosticsRequest) {
    windowMinutes(request.windowMinutes);

    if (
      request.methodKeys.length > 32 ||
      request.methodKeys.some((key) => key.length > 256) ||
      request.methodKeys.some((key) => !METHOD_KEYS.has(key)) ||
      request.sortBy.length > 16 ||
      request.callKind.length > 8 ||
      request.offset > MAX_METHODS ||
      request.limit > 32
    )
      throw new ConnectError("Diagnostics page exceeds budget", Code.InvalidArgument);

    if (!request.computerId || request.computerId === (this.core.computers?.hello().nodeId ?? "local"))
      return this.read(request);
    await this.peers.catalog();
    const peer = this.peers.peers.find((value) => value.node_id === request.computerId);

    if (!peer) throw new ConnectError("Computer not found", Code.NotFound);

    return this.peers.view(peer, request);
  }

  async stop() {
    this.resources.stop();
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    await this.persistence?.stop();
    this.peers.close();
  }

  async read(request: ui.ComputerDiagnosticsRequest) {
    if (windowMinutes(request.windowMinutes) === 1440 && this.history) {
      await this.history.load(this.collector.clock.utc());
    }

    return this.local(request);
  }

  #peerState() {
    if (Date.now() - this.#cacheSavedAt < 300_000) return [];

    return this.peers.persisted();
  }
}
