import { create, toBinary } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import type { PeerRow } from "../computers/store.ts";
import { linkedMessage } from "../computers/remote.ts";
import { sanitizeSnapshot } from "./sanitize.ts";

type Cached = { value: ui.ComputerDiagnostics; received: number; bytes: number };

type Read = {
  key: string;
  node: string;
  request: ui.ComputerDiagnosticsRequest;
  due: number;
  delay: number;
  activeUntil: number;
};

/** One bounded background gather shared by all clients. A foreground read never awaits a partner. */
export class DiagnosticsPeers {
  readonly cache = new Map<string, Cached>();
  readonly reads = new Map<string, Read>();
  peers: readonly PeerRow[] = [];
  #catalogAt = 0;
  #catalog: Promise<void> | undefined;
  #running = 0;
  #bytes = 0;
  #budgetAt = 0;
  #budgetBytes = 0;
  #closed = false;
  #cursor = 0;

  constructor(readonly core: GatewayCore) {}

  catalog() {
    if (Date.now() - this.#catalogAt < 30_000) return Promise.resolve();
    this.#catalog ??= (async () => {
      this.peers = (await this.core.computers?.store.computers()) ?? [];
      this.#catalogAt = Date.now();
      const known = new Set(this.peers.map((peer) => peer.node_id));

      for (const key of this.cache.keys()) if (!known.has(key.split(":")[0]!)) this.remove(key.split(":")[0]!);

      const batch = Array.from(
        { length: Math.min(32, this.peers.length) },
        (_, index) => this.peers[(this.#cursor + index) % this.peers.length]!,
      );

      this.#cursor = this.peers.length ? (this.#cursor + 32) % this.peers.length : 0;

      for (const peer of batch)
        this.request(peer.node_id, create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true }), false);
    })().finally(() => {
      this.#catalog = undefined;
    });

    return this.#catalog;
  }

  invalidate(node: string, removed: boolean) {
    this.#catalogAt = 0;

    if (removed) this.remove(node);

    for (const read of this.reads.values()) if (read.node === node) read.due = 0;
  }

  remove(node: string) {
    for (const [key, value] of this.cache)
      if (key.startsWith(`${node}:`)) {
        this.#bytes -= value.bytes;
        this.cache.delete(key);
      }

    for (const [key, read] of this.reads) if (read.node === node) this.reads.delete(key);
  }

  async revoke(node: string) {
    this.remove(node);
    this.#put(
      `${node}:overview`,
      create(ui.ComputerDiagnosticsSchema, { computerId: node, status: "not_permitted" }),
      256,
    );
    const store = this.core.computers?.store;

    await store?.query(
      `INSERT INTO diagnostics_peer_cache(owner_user_id,computer_id,payload,received_at,invalidated_at)
      SELECT $1::uuid,$2,''::bytea,now(),now() WHERE EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2)
      ON CONFLICT(owner_user_id,computer_id) DO UPDATE SET payload=''::bytea,invalidated_at=now()`,
      [store.owner, node],
    );
  }

  #key(node: string, request: ui.ComputerDiagnosticsRequest) {
    return `${node}:${request.overviewOnly ? `overview:${request.windowMinutes || 15}` : `${request.windowMinutes || 15}:${request.offset}:${request.sortBy}:${request.callKind}:${request.methodKeys.join(",")}`}`;
  }

  request(node: string, request: ui.ComputerDiagnosticsRequest, active = true) {
    const key = this.#key(node, request);
    let read = this.reads.get(key);

    if (!read) {
      if (this.reads.size >= 160) {
        const old = [...this.reads.values()].find((value) => value.activeUntil < Date.now());

        if (!old) return;
        this.reads.delete(old.key);
      }

      read = { key, node, request, due: 0, delay: 0, activeUntil: 0 };
      this.reads.set(key, read);
    }

    if (active) read.activeUntil = Date.now() + 45_000;
    void this.tick();

    return this.cache.get(key);
  }

  async tick() {
    if (this.#closed || this.#running >= 2) return;
    const now = Date.now();

    if (now - this.#budgetAt >= 1000) {
      this.#budgetAt = now;
      this.#budgetBytes = 0;
    }

    for (const read of this.reads.values()) {
      if (this.#running >= 2) break;

      if (read.due > now || (!read.request.overviewOnly && read.activeUntil < now)) continue;
      const reserve = read.request.overviewOnly ? 16 * 1024 : 64 * 1024;

      if (this.#budgetBytes + reserve > 64 * 1024) continue;
      const computers = this.core.computers;

      if (!computers?.canCall(read.node) || !computers.capabilities(read.node).includes("diagnostics_v1")) continue;
      read.due = now + 300_000;
      this.#running++;
      // Reserve a full response before starting, including relayed traffic.
      this.#budgetBytes += reserve;
      void this.#refresh(read).finally(() => {
        this.#running--;
      });
    }
  }

  async #refresh(read: Read) {
    try {
      const old = this.cache.get(read.key);

      const request = create(ui.ComputerDiagnosticsRequestSchema, {
        ...read.request,
        computerId: "",
        revision: old?.value.revision ?? "",
      });

      for await (const result of this.core.computers!.remote(
        read.node,
        link.DiagnosticsService.method.readDiagnosticsSnapshot,
        request,
        AbortSignal.timeout(3000),
      )) {
        const value = sanitizeSnapshot(linkedMessage(ui.ComputerDiagnosticsSchema, result));
        const bytes = toBinary(ui.ComputerDiagnosticsSchema, value).length;

        if (bytes > (read.request.overviewOnly ? 16 * 1024 : 64 * 1024))
          throw new ConnectError("Diagnostics snapshot exceeds budget", Code.ResourceExhausted);

        if (this.reads.get(read.key) !== read || this.#closed) return;

        if (value.notModified && old) {
          old.received = performance.now();
          old.value.sampleAgeMs = value.sampleAgeMs;
          old.value.receivedAtMs = BigInt(Date.now());
        } else this.#put(read.key, { ...value, computerId: read.node, receivedAtMs: BigInt(Date.now()) }, bytes);
      }

      read.delay = 0;
      read.due = Date.now() + (read.request.overviewOnly ? (read.activeUntil > Date.now() ? 30_000 : 60_000) : 10_000);
    } catch (error) {
      if (this.reads.get(read.key) !== read || this.#closed) return;

      if (error instanceof ConnectError && error.code === Code.PermissionDenied) {
        await this.revoke(read.node);
      }

      read.delay = Math.min(300_000, Math.max(30_000, read.delay * 2));
      read.due = Date.now() + read.delay;
    }
  }

  #put(key: string, value: ui.ComputerDiagnostics, bytes: number) {
    const node = value.computerId;
    const nodes = new Set([...this.cache.values()].map((entry) => entry.value.computerId));

    if (!nodes.has(node) && nodes.size >= 32) {
      const oldest = this.cache.values().next().value;

      if (oldest) this.remove(oldest.value.computerId);
    }

    const details = [...this.cache].filter(
      ([key, entry]) => entry.value.computerId === node && !key.includes(":overview"),
    );

    let detailBytes = details.reduce((sum, [, entry]) => sum + entry.bytes, 0);

    for (const [oldKey, entry] of details) {
      if (detailBytes + bytes <= 256 * 1024) break;
      this.cache.delete(oldKey);
      this.#bytes -= entry.bytes;
      detailBytes -= entry.bytes;
    }

    const previous = this.cache.get(key);
    this.#bytes -= previous?.bytes ?? 0;
    this.cache.delete(key);

    while ((this.#bytes + bytes > 8 * 1024 * 1024 || this.cache.size >= 160) && this.cache.size) {
      const first = this.cache.entries().next().value;

      if (!first) break;
      this.#bytes -= first[1].bytes;
      this.cache.delete(first[0]);
    }

    this.cache.set(key, { value, bytes, received: performance.now() });
    this.#bytes += bytes;
  }

  view(peer: PeerRow, request = create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true })) {
    const computers = this.core.computers;
    const cached = this.request(peer.node_id, request);

    const overview =
      this.cache.get(`${peer.node_id}:overview:${request.windowMinutes || 15}`) ??
      this.cache.get(`${peer.node_id}:overview`);

    const entry = cached ?? overview;
    const age = entry ? entry.value.sampleAgeMs + Math.max(0, performance.now() - entry.received) : 0;

    const supported =
      peer.capabilities.includes("diagnostics_v1") || computers?.capabilities(peer.node_id).includes("diagnostics_v1");

    const status = !supported
      ? "unsupported"
      : entry?.value.status === "not_permitted"
        ? "not_permitted"
        : !computers?.canCall(peer.node_id)
          ? "offline"
          : !cached
            ? "loading"
            : age > 90_000
              ? "stale"
              : "online";

    return create(ui.ComputerDiagnosticsSchema, {
      ...(entry?.value ?? create(ui.ComputerDiagnosticsSchema)),
      computerId: peer.node_id,
      name: peer.display_name || peer.name,
      appVersion: peer.app_version,
      status,
      sampleAgeMs: age,
      calls: cached && !request.overviewOnly ? cached.value.calls : [],
      detailsAvailable: Boolean(cached && !request.overviewOnly),
    });
  }

  restore(values: ui.ComputerDiagnostics[]) {
    for (const value of values.slice(0, 32))
      this.#put(
        `${value.computerId}:overview:${value.windowMinutes || 15}`,
        create(ui.ComputerDiagnosticsSchema, {
          ...value,
          sampleAgeMs: value.sampleAgeMs + Math.max(0, Date.now() - Number(value.receivedAtMs || value.sampledAtMs)),
          ageUncertain: true,
          receivedAtMs: BigInt(Date.now()),
          calls: [],
        }),
        toBinary(ui.ComputerDiagnosticsSchema, value).length,
      );
  }

  persisted() {
    return [
      ...new Map(
        [...this.cache].flatMap(([key, entry]) =>
          key.includes(":overview") ? [[entry.value.computerId, entry.value] as const] : [],
        ),
      ).values(),
    ]
      .slice(0, 32)
      .map((value) => create(ui.ComputerDiagnosticsSchema, { ...value, calls: [] }));
  }

  close() {
    this.#closed = true;
    this.reads.clear();
    this.cache.clear();
  }
}
