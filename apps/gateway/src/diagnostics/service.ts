import { create } from "@bufbuild/protobuf";
import { ui, type WorkerMessage } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import type { WorkerConnection } from "../worker-link/connection.ts";
import { RpcCollector } from "./collector.ts";
import { RPC_METHODS, LINKED_METHODS, COMMAND_METHODS, methodId } from "./registry.ts";
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

export class Diagnostics {
  readonly collector = new RpcCollector([...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS]);
  readonly interceptor = diagnosticsInterceptor(this.collector);
  readonly findings = new Findings();
  readonly links = new Map<string, LinkDiagnostics>();
  readonly peers: DiagnosticsPeers;
  readonly linkBudget = new BucketBudget(8 * 1024 * 1024);
  persistence: DiagnosticsPersistence | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #minute = 0;
  #unsubscribe: (() => void) | undefined;
  #snapshots = new Map<number, { at: number; value: ReturnType<typeof rpcSnapshot> }>();
  #workers: readonly { id: string; name: string; supported: boolean }[] = [];
  #workersAt = 0;
  #workersLoading = false;
  #workersLimited = false;
  #cacheSavedAt = 0;

  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
  ) {
    this.collector.enabled = options.diagnosticsEnabled ?? true;
    this.peers = new DiagnosticsPeers(core);
  }

  async start() {
    if (!this.collector.enabled) return;

    if (this.#timer) return;
    const computer = this.core.computers?.hello().nodeId ?? "local";
    this.persistence = new DiagnosticsPersistence(
      new DiagnosticsStore(this.options.runtime, this.options.userId, computer),
      this.collector,
      {
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
    void this.#workerCatalog();
    await this.persistence.start();
  }

  link(target: string, kind: "worker" | "computer") {
    const key = `${kind}:${target}`;
    let value = this.links.get(key);

    if (!value && this.links.size < 63) {
      value = new LinkDiagnostics(target, kind, this.linkBudget);
      this.links.set(key, value);
    }

    return value;
  }

  workerMessage(connection: WorkerConnection, message: WorkerMessage) {
    if (!this.collector.enabled) return message.payload.case === "diagnostics";
    const link = this.link(connection.workerId, "worker");

    if (message.payload.case === "heartbeat") link?.heartbeat();

    if (message.payload.case === "diagnostics") {
      if (connection.hello.capabilities.includes("diagnostics_v1")) link?.report(message.payload.value, connection);

      return true;
    }

    return false;
  }

  command(kind: string) {
    return this.collector.start(methodId(`command:${kind}`));
  }

  tick() {
    this.collector.tick();

    for (const link of this.links.values()) link.collector.tick();
    void this.peers.catalog().catch(() => {});
    void this.peers.tick();
    void this.#workerCatalog();
    const minute = Math.floor(Date.now() / 60_000);

    if (minute !== this.#minute) {
      this.#minute = minute;
      this.findings.evaluate(
        this.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: 15, limit: 384 }), true),
        this.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: 1, limit: 384 }), true),
      );
      void this.persistence?.flush();
    }
  }

  local(request: ui.ComputerDiagnosticsRequest, internal = false) {
    const minutes = windowMinutes(request.windowMinutes);

    if (
      (request.sortBy && !diagnosticsSorts.some((sort) => sort.value === request.sortBy)) ||
      (request.callKind && !["unary", "stream"].includes(request.callKind)) ||
      request.methodKeys.length > 32
    )
      throw new ConnectError("Choose an available call view", Code.InvalidArgument);

    if (request.offset > 384 || (!internal && request.limit > 32))
      throw new ConnectError("Diagnostics page exceeds budget", Code.InvalidArgument);
    let cached = this.#snapshots.get(minutes);
    const now = this.collector.clock.utc();

    if (!cached || now - cached.at >= 5000) {
      cached = { at: now, value: rpcSnapshot(this.collector, minutes) };
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

    const revision = `${this.collector.session}:${Math.floor(cached.at / 5000)}:${minutes}:${request.offset}:${request.sortBy}:${request.callKind}:${request.methodKeys.join(",")}`;
    const computer = this.core.computers;
    const links = this.#links(minutes);

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
      droppedSamples: BigInt(this.collector.budget.dropped + this.linkBudget.dropped + links.dropped),
      detailsAvailable: !request.overviewOnly,
      windowMinutes: minutes,
    });

    return internal ? result : diagnosticsResponse(result, request);
  }

  #links(minutes: number) {
    const result: ui.DiagnosticsLink[] = [];
    let dropped = Number(this.#workersLimited);

    const workers = new Map(this.#workers.map((worker) => [worker.id, worker]));

    for (const connection of this.core.link.connections.values())
      workers.set(connection.workerId, {
        id: connection.workerId,
        name: workers.get(connection.workerId)?.name ?? "Worker",
        supported: connection.hello.capabilities.includes("diagnostics_v1"),
      });

    for (const worker of workers.values()) {
      const link = this.link(worker.id, "worker");

      if (link)
        result.push(link.snapshot(minutes, worker.name, worker.supported, this.core.link.connections.has(worker.id)));
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
      const link = this.links.get(`computer:${peer.node_id}`);

      if (link)
        result.push(
          link.snapshot(
            minutes,
            peer.display_name || peer.name,
            peer.capabilities.includes("diagnostics_v1"),
            this.core.computers?.canCall(peer.node_id) ?? false,
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
        this.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: minutes, overviewOnly: true })),
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
      request.sortBy.length > 16 ||
      request.callKind.length > 8 ||
      request.offset > 384 ||
      request.limit > 32
    )
      throw new ConnectError("Diagnostics page exceeds budget", Code.InvalidArgument);

    if (!request.computerId || request.computerId === (this.core.computers?.hello().nodeId ?? "local"))
      return this.local(request);
    await this.peers.catalog();
    const peer = this.peers.peers.find((value) => value.node_id === request.computerId);

    if (!peer) throw new ConnectError("Computer not found", Code.NotFound);

    return this.peers.view(peer, request);
  }

  async stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    await this.persistence?.stop();
    this.peers.close();
  }

  #peerState() {
    if (Date.now() - this.#cacheSavedAt < 300_000) return [];

    return this.peers.persisted();
  }

  async #workerCatalog() {
    if (this.#workersLoading || Date.now() - this.#workersAt < 30_000) return;
    this.#workersLoading = true;

    try {
      this.#workers = await new DiagnosticsStore(this.options.runtime, this.options.userId, "local").query<{
        id: string;
        name: string;
        supported: boolean;
      }>(
        `SELECT id,name,coalesce((capabilities->>'diagnosticsV1')::boolean,false) AS supported FROM workers
         WHERE owner_user_id=$1::uuid AND archived_at IS NULL AND revoked_at IS NULL ORDER BY name LIMIT 257`,
        [this.options.userId],
      );
      this.#workersLimited = this.#workers.length > 256;
      this.#workers = this.#workers.slice(0, 256);
      this.#workersAt = Date.now();
    } catch {
      /* Keep the last owner-scoped catalog during a database outage. */
    } finally {
      this.#workersLoading = false;
    }
  }
}
