import { create, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { AsyncChannel } from "@canopy/transport";
import { MIN_COMPUTER_LINK_PROTOCOL, COMPUTER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";
import { AGENT_BUS, LAN_ROUTES, NODE_REF_LENGTH, RELAY, REMOTE_BOTS, REMOTE_THREADS, SHARED_CONFIG, THREAD_MIRROR } from "@canopy/domain/computers";
import { ThreadMirror } from "./mirror.ts";
import { BOT_METHODS, RemoteCalls, type RemoteServe, type RelayRoute } from "./remote.ts";
import { ComputerRelay, RELAY_METHODS, relayCallback } from "./relay.ts";
import { BotMirror } from "./bot-mirror.ts";
import { SharedConfig, type SharedHost } from "./shared.ts";
import { ComputerStore, type PeerRow } from "./store.ts";
import { Routes, type RouteRow } from "./routes.ts";
import { LanDiscovery, type LanTransportFactory } from "./lan.ts";
import { certificateIdentity, computerName, linkAddress } from "./identity.ts";
import { discoverCertificate, linkClient, listenLink, remoteCertificate, type LinkIdentity } from "./transport.ts";

type Connection = { send: (frame: MessageInitShape<typeof link.LinkFrameSchema>) => void; close: () => void; seen: number; ready: boolean;
  protocol?: number; capabilities?: Set<string>; remote?: RemoteCalls; relayReady?: boolean };
type Options = { store: ComputerStore; host?: string; port?: number; addresses?: string[]; minProtocol?: number; maxProtocol?: number; heartbeatMs?: number;
  /** Serves linked computers' calls on this computer's threads (stage 2). Without it the capability is not offered. */
  serve?: RemoteServe;
  /** Configuration shared with linked computers (stage 4). Without it the capability is not offered. */
  shared?: SharedHost;
  /** The owner's IANA zone for "unreachable since 19:42". */
  zone?: () => Promise<string | undefined>;
  /** Overrides the advertised capabilities (tests of older computers). */
  capabilities?: string[];
  /** Local network discovery of linked computers (stage 6). Without it discovery is unavailable. */
  discovery?: { transport: LanTransportFactory; unavailable?: string; now?: () => number; queryIntervalMs?: number; testIntervalMs?: number } };
/** A peer changed (presence, name, capabilities) or was removed. */
export type ComputerChange = { nodeId: string; removed: boolean };
const ms = (date: Date | null) => date ? BigInt(new Date(date).getTime()) : 0n;
const peerMessage = (p: PeerRow, capabilities: string[] = [], routes: RouteRow[] = []) => create(ui.LinkedComputerSchema, { nodeId: p.node_id, name: p.name, displayName: p.display_name,
  addresses: p.addresses, fingerprint: p.fingerprint, appVersion: p.app_version, minProtocol: p.min_protocol, maxProtocol: p.max_protocol,
  status: p.status, statusSinceMs: ms(p.status_since), lastSeenMs: ms(p.last_seen), linkedAtMs: ms(p.linked_at), updateNodeId: p.update_node_id, capabilities,
  routes: routes.map((r) => ({ address: r.address, source: r.source, addedAtMs: ms(r.added_at), lastSuccessMs: ms(r.last_success), lastFailureMs: ms(r.last_failure), latencyMs: r.latency_ms ?? 0 })) });
const WILDCARD = new Set(["0.0.0.0", "::"]);
const STATE_TEXT: Record<string, string> = { updating: "is updating", sleeping: "went to sleep", shutting_down: "shut down", unreachable: "is unreachable", pairing_required: "must be paired again" };

export async function computerGuard<A>(run: () => Promise<A>): Promise<A> {
  try { return await run(); } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Computer link operation failed. Check the address, code and listener settings.", Code.FailedPrecondition);
  }
}

/** Presence, live calls and read-only thread mirrors. No user work is ever queued here. */
export class LinkedComputers {
  #identity!: Awaited<ReturnType<ComputerStore["identity"]>>;
  #listener: Awaited<ReturnType<typeof listenLink>> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #paused = false;
  #announced = "connected";
  #active = new Map<string, Set<Connection>>();
  #dialing = new Map<string, AbortController>();
  #tasks = new Set<Promise<void>>();
  #retry = new Map<string, { at: number; delay: number }>();
  #addresses: string[] = [];
  #tickRunning = false;
  #listeners = new Set<(change: ComputerChange) => void>();
  #names = new Map<string, string>();
  #capabilities = new Map<string, string[]>();
  #mirroring = new Map<string, AbortController>();
  #botMirroring = new Map<string, AbortController>();
  #sharing = false;
  #routes: Routes;
  #lan: LanDiscovery | undefined;
  #lanError = "";
  #advertised: string[] = [];
  #network = "";
  #tested = new Map<string, number>();
  #testBudget = { start: 0, count: 0 };
  readonly mirror: ThreadMirror;
  readonly botMirror: BotMirror;
  readonly shared: SharedConfig | undefined;
  readonly relay: ComputerRelay;
  constructor(readonly options: Options) {
    this.#routes = new Routes(options.store);
    this.mirror = new ThreadMirror(options.store);
    this.botMirror = new BotMirror(options.store);
    this.relay = new ComputerRelay(options.store, {
      self: () => this.#identity.node_id,
      enabled: (nodeId) => this.hello().capabilities.includes(RELAY) && this.capabilities(nodeId).includes(RELAY),
      send: (nodeId, catalog) => { for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol && c.capabilities?.has(RELAY)) c.send({ body: { case: "relayCatalog", value: catalog } }); },
      changed: (nodeId, removed) => this.#emit(nodeId, removed),
    });
    this.shared = options.shared && options.serve ? new SharedConfig(options.store, options.shared, {
      self: () => this.#identity.node_id,
      ready: () => this.#sharesConfig() ? this.reachable().filter((n) => !this.relay.entries.has(n) && this.capabilities(n).includes(SHARED_CONFIG)) : [],
      outdated: async () => (await this.store.peers()).filter((p) => this.capabilities(p.node_id).length && !this.capabilities(p.node_id).includes(SHARED_CONFIG)).map((p) => p.node_id),
      call: (nodeId, method, request, signal) => this.remote(nodeId, method, request, signal),
    }) : undefined;
  }
  get store() { return this.options.store; }
  get identity(): LinkIdentity { return this.#identity; }
  get addresses() { return this.#addresses; }
  hello() { return create(link.NodeHelloSchema, { nodeId: this.#identity.node_id, name: this.#identity.name, addresses: this.#advertised,
    appVersion: CANOPY_VERSION, minProtocol: this.options.minProtocol ?? MIN_COMPUTER_LINK_PROTOCOL, maxProtocol: this.options.maxProtocol ?? COMPUTER_LINK_PROTOCOL,
    capabilities: this.options.capabilities ?? ["presence", "unlink", LAN_ROUTES, ...(this.options.serve ? [REMOTE_THREADS, THREAD_MIRROR, REMOTE_BOTS, AGENT_BUS, RELAY] : []), ...(this.shared ? [SHARED_CONFIG] : [])] }); }
  #sharesConfig() { return Boolean(this.shared) && this.hello().capabilities.includes(SHARED_CONFIG); }
  async start() {
    this.#identity = await this.store.identity();
    for (const peer of await this.store.peers()) this.#capabilities.set(peer.node_id, peer.capabilities);
    await this.shared?.load();
    // A process restart never claims an old connection is still alive.
    await this.store.query("UPDATE computer_peers SET status='unreachable',status_since=now() WHERE owner_user_id=$1::uuid AND status IN ('connected','needs_update')", [this.store.owner]);
    await this.relay.load();
    await this.#listen();
    await this.#discovery();
    this.#timer = setInterval(() => { void this.#tick().catch(() => {}); }, this.options.heartbeatMs ?? 5000);
    await this.#tick();
  }
  async #listen() {
    if (this.#listener || !this.options.host || !this.#identity.listener_enabled || this.#stopped || this.#paused) return;
    this.#listener = await listenLink({ host: this.options.host, port: this.options.port ?? 0, identity: this.#identity, routes: this.routes });
    const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
    this.#addresses = this.options.addresses?.map(linkAddress) ?? (WILDCARD.has(this.options.host) ? [] : [`https://${host}:${this.#listener.port}`]);
    this.#advertise();
  }
  // ------------------------------------------------------------------ stage 6: routes and LAN discovery

  /** Addresses sent to partners: the configured ones and, for a listener on every interface with
   * discovery on, this computer's current local network addresses. A change is announced over the link. */
  #advertise() {
    const port = this.#listener?.port;
    const interfaces = this.#lan?.transport?.interfaces() ?? [];
    const local = port && this.options.host && WILDCARD.has(this.options.host) ? interfaces.map((i) => `https://${i.address}:${port}`) : [];
    const next = this.#listener ? [...new Set([...this.#addresses, ...local])].slice(0, 16) : [];
    // A new network or listener: announce on the local network at once, not at the next window.
    const network = `${port ?? ""}|${interfaces.map((i) => i.address).join()}`;
    if (network !== this.#network) { this.#network = network; void this.#lan?.tick(true).catch(() => {}); }
    if (next.join() === this.#advertised.join()) return;
    this.#advertised = next;
    for (const set of this.#active.values()) for (const c of set) {
      if (c.ready && c.protocol && c.capabilities?.has(LAN_ROUTES)) c.send({ body: { case: "routes", value: { addresses: next } } });
    }
  }
  async #discovery() {
    const enabled = Boolean(this.options.discovery && !this.options.discovery.unavailable && this.#identity.lan_discovery && !this.#stopped);
    if (!enabled) {
      const lan = this.#lan; this.#lan = undefined;
      await lan?.close();
    } else if (!this.#lan) {
      const { transport, now, queryIntervalMs } = this.options.discovery!;
      const lan = new LanDiscovery({ transport, ...(now && { now }), ...(queryIntervalMs && { queryIntervalMs }),
        self: () => ({ nodeId: this.#identity.node_id, privateKey: this.#identity.privateKey }), partners: () => this.store.peers(),
        listener: () => this.#listener && this.options.host ? { port: this.#listener.port, host: this.options.host } : undefined,
        found: (nodeId, address) => void this.#found(nodeId, address).catch(() => {}) });
      this.#lan = lan;
      try { await lan.start(); this.#lanError = ""; } catch {
        this.#lan = undefined; await lan.close();
        this.#lanError = "Could not open the local network discovery socket (UDP 5353). Add routes manually.";
      }
    }
    this.#advertise();
  }
  #lanState() {
    if (!this.#identity.lan_discovery) return { state: "off", note: "" };
    const unavailable = !this.options.discovery ? "Local network discovery isn't available on this gateway." : this.options.discovery.unavailable || this.#lanError;
    if (unavailable || !this.#lan) return { state: "unavailable", note: unavailable || "Starting…" };
    const host = this.options.host;
    const reachable = this.#listener && host && (WILDCARD.has(host) || this.#lan.transport?.interfaces().some((i) => i.address === host));
    return { state: "active", note: reachable ? "" : this.#listener ? "The link listener isn't on a local network interface, so this computer only looks for its linked computers." : "This computer looks for its linked computers. Turn on the listener so they can find it too." };
  }
  /** A partner announced itself on the local network. Trust never comes from the network: the address
   * is kept only after the normal pinned handshake proves it reaches the partner's own key. */
  async #found(nodeId: string, address: string) {
    if (this.#stopped || this.#paused || !this.#identity.lan_discovery) return;
    const now = Date.now();
    const key = `${nodeId} ${address}`;
    // Rate limits, checked and taken before any await so that a burst of answers makes one test:
    // one test per address and interval, and at most 20 tests a minute in total.
    if ((this.#tested.get(key) ?? 0) > now - (this.options.discovery?.testIntervalMs ?? 60_000)) return;
    if (now - this.#testBudget.start > 60_000) this.#testBudget = { start: now, count: 0 };
    if (this.#testBudget.count >= 20) return;
    this.#tested.delete(key); this.#tested.set(key, now);
    if (this.#tested.size > 256) this.#tested.delete(this.#tested.keys().next().value!);
    const budget = this.#testBudget; budget.count++;
    // A route that worked within ten minutes needs no new test (and gives its budget back).
    const known = (await this.#routes.list(nodeId)).find((r) => r.address === address);
    if (known?.last_success && new Date(known.last_success).getTime() > now - 600_000) { budget.count--; return; }
    const peer = await this.store.peer(nodeId);
    if (!peer) return;
    const started = performance.now();
    try { await discoverCertificate(address, peer.fingerprint, this.#identity); } catch {
      if (known) await this.#routes.failure(nodeId, address);
      return;
    }
    await this.#routes.add(nodeId, [address], "lan");
    await this.#routes.success(nodeId, address, performance.now() - started);
    this.#emit(nodeId);
    if (!this.#active.get(nodeId)?.size) { this.#retry.delete(nodeId); void this.#tick().catch(() => {}); }
  }
  routes = (router: ConnectRouter) => router.service(link.ComputerLinkService, {
    pair: async (request, context) => computerGuard(async () => {
      if (!request.hello || request.hello.nodeId === this.#identity.node_id) throw new ConnectError("Choose another computer", Code.InvalidArgument);
      await this.store.pair(request.secret, request.hello, context.values.get(remoteCertificate));
      void this.#lan?.refresh().catch(() => {});
      for (const c of this.#active.get(request.hello.nodeId) ?? []) c.close();
      this.#retry.delete(request.hello.nodeId);
      return create(link.PairResponseSchema, { hello: this.hello() });
    }),
    connect: (request, context) => this.#accept(request, context),
  });
  async snapshot() {
    const routes = await this.#routes.list();
    const lan = this.#lanState();
    return create(ui.ComputersSnapshotSchema, { self: { nodeId: this.#identity.node_id, name: this.#identity.name, fingerprint: this.#identity.fingerprint,
      addresses: this.#advertised, appVersion: CANOPY_VERSION, minProtocol: this.hello().minProtocol, maxProtocol: this.hello().maxProtocol },
      peers: await Promise.all((await this.store.computers()).map((p) => this.#computerMessage(p, routes.filter((r) => r.node_id === p.node_id)))),
      listenerEnabled: Boolean(this.#listener), listenerAvailable: Boolean(this.options.host),
      lanDiscoveryEnabled: this.#identity.lan_discovery, lanDiscoveryState: lan.state, lanDiscoveryNote: lan.note });
  }
  async createPairing() {
    if (!this.#listener || !this.#addresses.length) throw new ConnectError("Enable the link listener and configure at least one advertised address first", Code.FailedPrecondition);
    return create(ui.ComputerPairingSchema, await this.store.invitation(this.#identity.fingerprint, this.#addresses));
  }
  async pair(address: string, code: string) {
    address = linkAddress(address);
    const raw = code.replace(/[\s-]/g, "").toLowerCase();
    if (!/^[a-f0-9]{96}$/.test(raw)) throw new ConnectError("Paste the complete pairing code from the other computer", Code.InvalidArgument);
    const started = performance.now();
    const certificate = await discoverCertificate(address, raw.slice(0, 64), this.#identity);
    const latency = performance.now() - started;
    if (certificateIdentity(certificate).nodeId === this.#identity.node_id) throw new ConnectError("Choose another computer", Code.InvalidArgument);
    const response = await linkClient(address, certificate, this.#identity).pair({ secret: raw.slice(64), hello: this.hello() }, { timeoutMs: 10_000 });
    if (!response.hello) throw new ConnectError("The computer did not return an identity", Code.Unauthenticated);
    await this.store.remember(response.hello, certificate, address, latency);
    this.#retry.delete(response.hello.nodeId);
    void this.#lan?.refresh().catch(() => {});
    void this.#tick().catch(() => {});
    return this.snapshot();
  }
  async manage(request: ui.ComputerOperationRequest) {
    const { nodeId, action } = request;
    if (action === "share_onward") {
      await this.relay.set(nodeId, request.shareOnwardNodeIds);
      this.#emit(nodeId);
    } else if (action === "rename") {
      const name = computerName(request.name);
      if (!nodeId || nodeId === this.#identity.node_id) {
        await this.store.query("UPDATE computer_identity SET name=$2 WHERE owner_user_id=$1::uuid", [this.store.owner, name]);
        this.#identity.name = name;
        this.#broadcast({ body: { case: "hello", value: this.hello() } });
      } else {
        if (!await this.store.peer(nodeId)) throw new ConnectError("Computer not found", Code.NotFound);
        await this.store.query("UPDATE computer_peers SET display_name=$3 WHERE owner_user_id=$1::uuid AND node_id=$2", [this.store.owner, nodeId, name]);
        this.#names.set(nodeId, name);
        this.#emit(nodeId);
      }
    } else if (action === "unlink") {
      if (!await this.store.peer(nodeId)) throw new ConnectError("Computer not found", Code.NotFound);
      // Persist revocation before releasing trust. A peer offline now learns it
      // through the authenticated control channel on its next reconnect.
      await this.store.remove(nodeId, true);
      await this.relay.refresh();
      this.#emit(nodeId, true);
      this.shared?.changed();
      for (const connection of this.#active.get(nodeId) ?? []) connection.send({ body: { case: "unlinked", value: {} } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const connection of this.#active.get(nodeId) ?? []) connection.close();
      this.#dialing.get(nodeId)?.abort();
      this.#retry.delete(nodeId);
      void this.#lan?.refresh().catch(() => {});
    } else if (action === "revoke_pairing") {
      await this.store.query("UPDATE computer_pairings SET revoked_at=now() WHERE owner_user_id=$1::uuid AND used_at IS NULL", [this.store.owner]);
    } else if (action === "listener") {
      if (!this.options.host) throw new ConnectError("Enable Allow other machines to connect in desktop settings, or configure CANOPY_LINK_HOST", Code.FailedPrecondition);
      if (request.enabled) {
        this.#identity.listener_enabled = true;
        await this.#listen();
      } else {
        this.#identity.listener_enabled = false;
        await this.#listener?.close(); this.#listener = undefined; this.#addresses = [];
        this.#advertise();
      }
      await this.store.query("UPDATE computer_identity SET listener_enabled=$2 WHERE owner_user_id=$1::uuid", [this.store.owner, request.enabled]);
    } else if (action === "lan_discovery") {
      await this.store.query("UPDATE computer_identity SET lan_discovery=$2 WHERE owner_user_id=$1::uuid", [this.store.owner, request.enabled]);
      this.#identity.lan_discovery = request.enabled;
      // Off: nothing is announced or asked for, and paths found on a network are forgotten.
      if (!request.enabled) await this.#routes.forgetLan();
      await this.#discovery();
    } else if (action === "add_route" || action === "remove_route") {
      if (!await this.store.peer(nodeId)) throw new ConnectError("Computer not found", Code.NotFound);
      const address = linkAddress(request.address);
      if (action === "add_route") {
        await this.#routes.add(nodeId, [address], "manual");
        this.#retry.delete(nodeId);
      } else if (!await this.#routes.remove(nodeId, address)) throw new ConnectError("Route not found", Code.NotFound);
      this.#emit(nodeId);
    } else if (action === "presence") await this.announce(request.name);
    else throw new ConnectError("Unknown computer operation", Code.InvalidArgument);
    return this.snapshot();
  }
  #broadcast(frame: MessageInitShape<typeof link.LinkFrameSchema>) { for (const set of this.#active.values()) for (const c of set) c.send(frame); }
  #track(nodeId: string, connection: Connection) {
    const set = this.#active.get(nodeId) ?? new Set(); set.add(connection); this.#active.set(nodeId, set);
    return async () => {
      connection.remote?.close();
      set.delete(connection);
      if (!set.size) {
        this.#active.delete(nodeId);
        if (this.#stopped) return;
        const peer = await this.store.peer(nodeId);
        if (peer && ["connected", "needs_update"].includes(peer.status)) await this.#status(nodeId, "unreachable", peer.update_node_id);
        else this.#emit(nodeId);
      } else this.#emit(nodeId);
      this.relay.check();
      await this.relay.refresh();
    };
  }
  async #receive(nodeId: string, frame: link.LinkFrame, connection: Connection) {
    const body = frame.body;
    if (body.case === "remoteRequest" || body.case === "remoteResponse" || body.case === "remoteCancel") {
      // Only after a handshake with a common protocol; the peer was verified then and unlink closes the stream.
      if (!connection.remote) throw new ConnectError("Remote calls need a compatible link", Code.FailedPrecondition);
      connection.seen = Date.now();
      connection.remote.receive(body);
      return;
    }
    if (body.case === "unlinked") {
      await this.store.remove(nodeId, false);
      await this.relay.refresh();
      this.#emit(nodeId, true);
      this.shared?.changed();
      for (const c of this.#active.get(nodeId) ?? []) c.close();
      this.#dialing.get(nodeId)?.abort(); return;
    }
    const peer = await this.store.peer(nodeId);
    if (!peer) { connection.send({ body: { case: "unlinked", value: {} } }); return; }
    connection.seen = Date.now();
    if (body.case === "hello" || body.case === "welcome") {
      const hello = body.case === "hello" ? body.value : body.value.hello;
      if (!hello) throw new ConnectError("Missing handshake", Code.InvalidArgument);
      this.store.validateHello(hello, nodeId);
      const local = this.hello();
      const protocol = hello.minProtocol > 0 && hello.maxProtocol >= hello.minProtocol &&
        Math.max(local.minProtocol, hello.minProtocol) <= Math.min(local.maxProtocol, hello.maxProtocol) ? Math.min(local.maxProtocol, hello.maxProtocol) : 0;
      const updateNodeId = protocol ? "" : (hello.maxProtocol < local.minProtocol ? nodeId : local.nodeId);
      await this.store.query(`UPDATE computer_peers SET name=$3,app_version=$4,min_protocol=$5,max_protocol=$6,capabilities=$7::jsonb
        WHERE owner_user_id=$1::uuid AND node_id=$2`, [this.store.owner, nodeId, hello.name, hello.appVersion, hello.minProtocol, hello.maxProtocol, JSON.stringify(hello.capabilities)]);
      await this.#routes.add(nodeId, hello.addresses.map(linkAddress), "announced");
      connection.protocol = protocol;
      connection.capabilities = new Set(hello.capabilities);
      this.#capabilities.set(nodeId, hello.capabilities);
      this.#names.set(nodeId, peer.display_name || hello.name);
      if (protocol && !connection.remote) connection.remote = new RemoteCalls({ send: (f) => connection.send(f),
        serve: (method, request, signal, _, route) => this.#serveRemote(nodeId, connection, method, request, signal, route),
        name: () => this.#names.get(nodeId) ?? "The other computer", allowed: async () => Boolean(await this.store.peer(nodeId)) });
      connection.ready = true;
      // A successful handshake ends the failure streak, including when the
      // eventual disconnect arrives as an exception rather than a clean EOF.
      this.#retry.delete(nodeId);
      await this.#status(nodeId, protocol ? "connected" : "needs_update", updateNodeId);
      if (body.case === "hello") {
        connection.send({ body: { case: "welcome", value: { hello: local, protocol, updateNodeId } } });
        if (this.#announced !== "connected") connection.send({ body: { case: "presence", value: { state: this.#announced, announcedAtMs: BigInt(Date.now()) } } });
      }
      // Both sides offer everything they share after each handshake; offline edits meet here.
      if (protocol && this.#sharesConfig() && hello.capabilities.includes(SHARED_CONFIG)) setTimeout(() => void this.shared?.push(nodeId, true).catch(() => {}), 0);
      this.shared?.changed();
      await this.relay.refresh();
    } else if (body.case === "relayCatalog") {
      if (!connection.protocol || !connection.capabilities?.has(RELAY) || !this.hello().capabilities.includes(RELAY)) throw new ConnectError("Relay needs an update on both computers", Code.FailedPrecondition);
      await this.relay.receive(nodeId, body.value);
      connection.relayReady = true;
      for (const p of this.relay.entries.values()) if (p.via_node_id === nodeId) this.#emit(p.node_id);
    } else if (body.case === "presence") {
      if (!["updating", "sleeping", "shutting_down", "connected"].includes(body.value.state)) throw new ConnectError("Unknown presence state", Code.InvalidArgument);
      await this.#status(nodeId, body.value.state === "connected" && peer.update_node_id ? "needs_update" : body.value.state, peer.update_node_id);
      await this.relay.refresh();
    } else if (body.case === "routes") {
      // The partner's addresses changed. Only over a negotiated link; they are routes like any other, used through the pin.
      if (!connection.protocol || body.value.addresses.length > 16) throw new ConnectError("Unsupported route announcement", Code.InvalidArgument);
      await this.#routes.add(nodeId, body.value.addresses.map(linkAddress), "announced");
      this.#emit(nodeId);
    } else if (body.case === "heartbeat") {
      await this.store.query("UPDATE computer_peers SET last_seen=now() WHERE owner_user_id=$1::uuid AND node_id=$2", [this.store.owner, nodeId]);
    } else throw new ConnectError("Unsupported link message", Code.InvalidArgument);
  }
  async *#accept(request: AsyncIterable<link.LinkFrame>, context: HandlerContext) {
    const remote = certificateIdentity(context.values.get(remoteCertificate));
    const peer = await this.store.peer(remote.nodeId);
    if (!peer) {
      const revoked = await this.store.query("SELECT node_id FROM computer_revocations WHERE owner_user_id=$1::uuid AND node_id=$2", [this.store.owner, remote.nodeId]);
      if (revoked.length) { yield create(link.LinkFrameSchema, { body: { case: "unlinked", value: {} } }); return; }
      throw new ConnectError("Computer certificate is not pinned. Pair this computer first.", Code.Unauthenticated);
    }
    if (peer.fingerprint !== remote.fingerprint) throw new ConnectError("Computer certificate changed. Unlink and pair again.", Code.Unauthenticated);
    const output = new AsyncChannel<link.LinkFrame>();
    const connection: Connection = { send: (f) => { if (!output.closed) output.push(create(link.LinkFrameSchema, f)); }, close: () => { output.close(); connection.remote?.close(); }, seen: Date.now(), ready: false };
    const release = this.#track(peer.node_id, connection);
    const abort = () => output.close(); context.signal.addEventListener("abort", abort, { once: true });
    const reader = (async () => {
      let first = true;
      try {
        for await (const frame of request) {
          if (first && frame.body.case !== "hello") throw new ConnectError("Handshake required", Code.FailedPrecondition);
          if (this.#stopped) break;
          first = false; await this.#receive(peer.node_id, frame, connection);
          if (output.closed) break;
        }
        output.close();
      } catch (error) { output.close(error); }
    })();
    this.#tasks.add(reader);
    void reader.finally(() => this.#tasks.delete(reader));
    try { yield* output; } finally { output.close(); context.signal.removeEventListener("abort", abort); void reader; await release(); }
  }
  async #tick() {
    if (this.#tickRunning || this.#stopped || this.#paused) return;
    this.#tickRunning = true;
    try {
      this.#advertise();
      if (this.shared && !this.#sharing) {
        this.#sharing = true;
        void this.configChanged().finally(() => { this.#sharing = false; });
      }
      for (const peer of await this.store.peers()) {
        if (this.#stopped || this.#paused) break;
        this.#syncMirror(peer.node_id);
        const active = this.#active.get(peer.node_id);
        if (active?.size) {
          for (const c of active) {
            if (Date.now() - c.seen > (this.options.heartbeatMs ?? 5000) * 4) c.close();
            else if (c.ready) c.send({ body: { case: "heartbeat", value: { sentAtMs: BigInt(Date.now()) } } });
          }
          continue;
        }
        if (this.#dialing.has(peer.node_id) || (this.#retry.get(peer.node_id)?.at ?? 0) > Date.now()) continue;
        const controller = new AbortController(); this.#dialing.set(peer.node_id, controller);
        const task = this.#dial(peer, controller).catch(() => {
          // Database failures must not escape the background reconnect loop.
          console.warn("Computer link reconnect failed; retrying on the next heartbeat");
        }).finally(() => { this.#dialing.delete(peer.node_id); this.#tasks.delete(task); });
        this.#tasks.add(task);
      }
      for (const p of this.relay.entries.values()) this.#syncMirror(p.node_id);
      await this.relay.refresh();
    } finally { this.#tickRunning = false; }
  }
  async #dial(peer: PeerRow, controller: AbortController) {
    for (const route of await this.#routes.list(peer.node_id)) {
      const { address } = route;
      if (controller.signal.aborted || this.#stopped || this.#paused || this.#active.get(peer.node_id)?.size) return;
      const output = new AsyncChannel<link.LinkFrame>();
      const routeController = new AbortController();
      const connection: Connection = { send: (f) => { output.push(create(link.LinkFrameSchema, f)); }, close: () => { output.close(); routeController.abort(); connection.remote?.close(); }, seen: Date.now(), ready: false };
      const release = this.#track(peer.node_id, connection);
      let greeted = false;
      try {
        connection.send({ body: { case: "hello", value: this.hello() } });
        // Queued hello is sent only after verification. No heartbeat may precede it.
        const started = performance.now();
        await discoverCertificate(address, peer.fingerprint, this.#identity);
        const latency = performance.now() - started;
        const deadline = setTimeout(() => { if (!greeted) routeController.abort(); }, 8000);
        try {
          for await (const frame of linkClient(address, peer.certificate, this.#identity).connect(output, { signal: AbortSignal.any([controller.signal, routeController.signal]) })) {
            if (!greeted && !["welcome", "unlinked"].includes(frame.body.case ?? "")) throw new ConnectError("Handshake required", Code.FailedPrecondition);
            if (!greeted && frame.body.case === "welcome") {
              if (this.#announced !== "connected") connection.send({ body: { case: "presence", value: { state: this.#announced, announcedAtMs: BigInt(Date.now()) } } });
            }
            greeted = true; clearTimeout(deadline);
            await this.#receive(peer.node_id, frame, connection);
            if (frame.body.case === "welcome") await this.#routes.success(peer.node_id, address, latency);
            if (controller.signal.aborted) break;
          }
        } finally { clearTimeout(deadline); }
        if (greeted) { this.#retry.delete(peer.node_id); break; }
      } catch (error) {
        const mismatch = error instanceof ConnectError && error.code === Code.Unauthenticated;
        // A pin mismatch never changes trust. Another device now has a discovered address: forget that path.
        // An address the user entered keeps the stage 1 meaning: the computer must be paired again.
        if (mismatch && route.source === "manual") await this.#status(peer.node_id, "pairing_required");
        if (mismatch && route.source === "lan") await this.#routes.remove(peer.node_id, address);
        else if (!greeted && !controller.signal.aborted) await this.#routes.failure(peer.node_id, address);
      }
      finally { output.close(); await release(); }
    }
    const delay = Math.min(30_000, (this.#retry.get(peer.node_id)?.delay ?? 500) * 2);
    this.#retry.set(peer.node_id, { delay, at: Date.now() + delay + Math.random() * delay / 4 });
  }
  /** A local change of configuration (or the heartbeat): version shared items and send what peers lack. */
  async configChanged() {
    if (!this.shared || this.#stopped) return;
    try {
      await this.shared.scan();
      await Promise.allSettled(this.shared.peers.ready().map((nodeId) => this.shared!.push(nodeId)));
    } catch { /* retried on the next heartbeat */ }
  }
  // ------------------------------------------------------------------ stage 2: remote threads

  /** A direct caller may request one relay leg. Only the relay can attest an
   * origin, and an attested request can only execute at this receiving home. */
  async *#serveRemote(nodeId: string, connection: Connection, method: DescMethod, request: Message, signal: AbortSignal, route?: RelayRoute): AsyncGenerator<Message> {
    if (!route?.targetNodeId) {
      if (route?.originNodeId || route?.relayHops) throw new ConnectError("Invalid relay envelope", Code.InvalidArgument);
      yield* this.#serveHome(nodeId, connection, method, request, signal);
      return;
    }
    if (!this.hello().capabilities.includes(RELAY) || !connection.capabilities?.has(RELAY) || !RELAY_METHODS.has(method.name))
      throw new ConnectError("This action cannot be relayed", Code.PermissionDenied);
    if (route.relayHops === 1) {
      if (route.targetNodeId !== this.#identity.node_id || !/^[a-f0-9]{64}$/.test(route.originNodeId) || [nodeId, this.#identity.node_id].includes(route.originNodeId))
        throw new ConnectError("Relay hop limit reached or loop detected", Code.PermissionDenied);
      const origin = this.relay.entries.get(route.originNodeId);
      if (!origin || origin.via_node_id !== nodeId || !this.#relayChannel(nodeId)
        || (origin.relay_role === "home" && !relayCallback(method, request)))
        throw new ConnectError("Origin is not shared through this relay", Code.PermissionDenied);
      yield* this.relay.guard(() => this.relay.entries.get(route.originNodeId)?.via_node_id === nodeId
        && (this.relay.entries.get(route.originNodeId)?.relay_role !== "home" || relayCallback(method, request)) && Boolean(this.#relayChannel(nodeId)), signal,
        (s) => this.#serveHome(route.originNodeId, connection, method, request, s));
      return;
    }
    if (route.relayHops !== 0 || route.originNodeId || [nodeId, this.#identity.node_id].includes(route.targetNodeId))
      throw new ConnectError("Relay hop limit reached or loop detected", Code.PermissionDenied);
    const target = await this.store.peer(route.targetNodeId);
    if (!target) throw new ConnectError("Relay targets must be direct partners (one hop)", Code.PermissionDenied);
    const callback = relayCallback(method, request);
    const feature = method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : method.name === "WatchThreadMirror" ? THREAD_MIRROR : REMOTE_THREADS;
    if (!connection.capabilities?.has(feature) || !this.capabilities(target.node_id).includes(feature)) throw new ConnectError("All computers need an update for this linked action", Code.FailedPrecondition);
    const allowed = () => this.relay.allowed(nodeId, target.node_id) || (callback && this.relay.allowed(target.node_id, nodeId));
    if (!allowed()) throw new ConnectError("Share onward is not enabled for this computer", Code.PermissionDenied);
    const remote = this.#relayChannel(target.node_id);
    if (!remote) throw await this.unavailable(target.node_id);
    yield* this.relay.guard(() => allowed() && Boolean(this.#relayChannel(nodeId)) && Boolean(this.#relayChannel(target.node_id)), signal,
      (s) => remote.call(method, request, s, { targetNodeId: target.node_id, originNodeId: nodeId, relayHops: 1 }));
  }

  async *#serveHome(nodeId: string, connection: Connection, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message> {
    if (!this.options.serve) throw new ConnectError("Thread sharing unavailable", Code.Unimplemented);
    const feature = method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : REMOTE_THREADS;
    if (!this.hello().capabilities.includes(feature) || !connection.capabilities?.has(feature))
      throw new ConnectError("Both computers need an update for this linked action", Code.Unimplemented);
    if (method.name === "WatchThreadMirror") {
      if (!this.hello().capabilities.includes(THREAD_MIRROR) || !connection.capabilities?.has(THREAD_MIRROR))
        throw new ConnectError("Thread mirrors need an update on both computers", Code.Unimplemented);
      yield* this.mirror.publish(request as link.MirrorRequest, this.options.serve, signal);
    } else if (method.name === "PushSharedConfig") {
      if (!this.shared || !this.#sharesConfig() || !connection.capabilities?.has(SHARED_CONFIG))
        throw new ConnectError("Shared configuration needs an update on both computers", Code.Unimplemented);
      yield await this.shared.receive(nodeId, request as link.SharedConfigPush);
    } else if (method.name === "WatchBotMirror") yield* this.botMirror.publish(request as link.MirrorRequest, this.options.serve, signal);
    else yield* this.options.serve(method, request, signal, nodeId);
  }

  subscribe(listener: (change: ComputerChange) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #emit(nodeId: string, removed = false) {
    if (removed) { this.#names.delete(nodeId); this.#capabilities.delete(nodeId); }
    for (const listener of this.#listeners) { try { listener({ nodeId, removed }); } catch { /* a subscriber's failure is its own */ } }
    this.#syncMirror(nodeId);
    // A relay's own reachability is part of every indirect computer's presence.
    for (const p of this.relay.entries.values()) if (p.via_node_id === nodeId) {
      for (const listener of this.#listeners) { try { listener({ nodeId: p.node_id, removed: false }); } catch { /* subscriber owns errors */ } }
      this.#syncMirror(p.node_id);
    }
    this.relay.check();
  }
  #syncMirror(nodeId: string) {
    this.#syncBotMirror(nodeId);
    const enabled = !this.#stopped && this.hello().capabilities.includes(THREAD_MIRROR)
      && this.capabilities(nodeId).includes(THREAD_MIRROR) && this.reachable().includes(nodeId);
    if (!enabled) { this.#mirroring.get(nodeId)?.abort(); return; }
    if (this.#mirroring.has(nodeId)) return;
    const controller = new AbortController(); this.#mirroring.set(nodeId, controller);
    const task = (async () => {
      try {
        const cursor = (await this.mirror.state(nodeId))?.cursor ?? "";
        const method = link.ThreadMirrorService.method.watchThreadMirror;
        await this.mirror.consume(nodeId, this.remote(nodeId, method, create(link.MirrorRequestSchema, { cursor }), controller.signal),
          () => { for (const listener of this.#listeners) { try { listener({ nodeId, removed: false }); } catch { /* subscriber owns its errors */ } } }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && error instanceof ConnectError && error.code === Code.DataLoss) await this.mirror.clearCursor(nodeId);
      } finally {
        if (this.#mirroring.get(nodeId) === controller) this.#mirroring.delete(nodeId);
      }
    })();
    this.#tasks.add(task);
    // A failed cursor write can reject during shutdown too. Observe both outcomes
    // without creating an unhandled rejected promise from finally().
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
  }
  #syncBotMirror(nodeId: string) {
    const enabled = !this.#stopped && this.hello().capabilities.includes(REMOTE_BOTS)
      && this.capabilities(nodeId).includes(REMOTE_BOTS) && this.reachable().includes(nodeId);
    if (!enabled) { this.#botMirroring.get(nodeId)?.abort(); return; }
    if (this.#botMirroring.has(nodeId)) return;
    const controller = new AbortController(); this.#botMirroring.set(nodeId, controller);
    const task = (async () => {
      try {
        const cursor = await this.botMirror.cursor(nodeId);
        await this.botMirror.consume(nodeId, this.remote(nodeId, link.LinkedAgentsService.method.watchBotMirror,
          create(link.MirrorRequestSchema, { cursor }), controller.signal), () => {
            for (const listener of this.#listeners) { try { listener({ nodeId, removed: false }); } catch { /* subscriber owns errors */ } }
          }, controller.signal);
      } catch { /* reconnect resumes from the last atomic checkpoint */ }
      finally { if (this.#botMirroring.get(nodeId) === controller) this.#botMirroring.delete(nodeId); }
    })();
    this.#tasks.add(task);
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
  }
  async #status(nodeId: string, status: string, updateNodeId = "") { await this.store.status(nodeId, status, updateNodeId); this.#emit(nodeId); }
  /** Live features, or the last handshake persisted for offline mirror reads. */
  capabilities(nodeId: string): string[] {
    const indirect = this.relay.entries.get(nodeId);
    if (indirect) return indirect.capabilities;
    const all = new Set<string>();
    for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol) for (const name of c.capabilities ?? []) all.add(name);
    return all.size ? [...all] : this.#capabilities.get(nodeId) ?? [];
  }
  #channel(nodeId: string) {
    for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol && c.capabilities?.has(REMOTE_THREADS) && c.remote && !c.remote.closed) return c.remote;
    return undefined;
  }
  /** Peers whose threads this computer can show and act on right now. */
  reachable(): string[] { return [...this.#active.keys(), ...this.relay.entries.keys()].filter((id) => this.canCall(id) && this.relay.entries.get(id)?.relay_role !== "origin"); }
  /** Includes callback-only origins for the agent bus's existing call references. */
  canCall(nodeId: string): boolean {
    const p = this.relay.entries.get(nodeId);
    if (!p) return Boolean(this.#channel(nodeId));
    return p.status === "connected" && Boolean(p.via_node_id && this.#relayChannel(p.via_node_id));
  }
  #relayChannel(nodeId: string) {
    if (!this.hello().capabilities.includes(RELAY)) return undefined;
    for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol && c.relayReady && c.capabilities?.has(RELAY) && c.remote && !c.remote.closed) return c.remote;
    return undefined;
  }
  async #computerMessage(peer: PeerRow, routes: RouteRow[] = []) {
    const result = peerMessage(peer, this.capabilities(peer.node_id), routes);
    result.shareOnwardNodeIds = this.relay.selected(peer.node_id);
    if (peer.via_node_id) {
      const via = await this.store.peer(peer.via_node_id);
      result.viaNodeId = peer.via_node_id; result.viaName = via?.display_name || via?.name || "the relay";
      result.relayOrigin = peer.relay_role === "origin";
      if (!this.#relayChannel(peer.via_node_id)) {
        result.status = via?.status === "connected" ? "unreachable" : via?.status || "unreachable";
        result.statusSinceMs = via ? ms(via.status_since) : result.statusSinceMs;
        result.unavailableReason = via?.status === "connected" ? `Available through ${result.viaName}, which is reconnecting.`
          : `Available through ${result.viaName}, which is unreachable since ${await this.#time(new Date(Number(result.statusSinceMs)))}`;
      }
    }
    return result;
  }
  async computer(nodeId: string) { const peer = await this.store.computer(nodeId); return peer && this.#computerMessage(peer); }
  /** The linked computer of a qualified id's suffix. */
  async resolve(ref: string): Promise<PeerRow> {
    const peers = ref.length === NODE_REF_LENGTH ? (await this.store.computers()).filter((p) => p.relay_role !== "origin" && p.node_id.startsWith(ref)) : [];
    if (peers.length !== 1) throw new ConnectError("That computer is no longer linked", Code.NotFound);
    return peers[0]!;
  }
  /** One call on a peer's home threads. Fails at once when it cannot be delivered; nothing waits for a reconnect. */
  async *remote(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message> {
    const indirect = this.relay.entries.get(nodeId);
    if (indirect) {
      if (!RELAY_METHODS.has(method.name) || (indirect.relay_role === "origin" && !relayCallback(method, request))) throw new ConnectError("This relay entry is read only", Code.PermissionDenied);
      const remote = indirect.via_node_id && this.#relayChannel(indirect.via_node_id);
      if (!remote || !this.canCall(nodeId)) throw await this.unavailable(nodeId);
      const feature = method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : method.name === "WatchThreadMirror" ? THREAD_MIRROR : REMOTE_THREADS;
      if (!this.hello().capabilities.includes(feature) || !indirect.capabilities.includes(feature)) throw new ConnectError("The linked computer needs an update for this action", Code.FailedPrecondition);
      yield* this.relay.guard(() => this.relay.entries.get(nodeId)?.via_node_id === indirect.via_node_id && this.relay.entries.get(nodeId)?.relay_role === indirect.relay_role && this.canCall(nodeId), signal,
        (s) => remote.call(method, request, s, { targetNodeId: nodeId, originNodeId: "", relayHops: 0 }));
      return;
    }
    const remote = this.#channel(nodeId);
    if (!remote) throw await this.unavailable(nodeId);
    const feature = method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : undefined;
    if (feature && (!this.hello().capabilities.includes(feature) || !this.capabilities(nodeId).includes(feature))) {
      const peer = await this.store.peer(nodeId);
      throw new ConnectError(`${peer?.display_name || peer?.name || "The other computer"} needs an update for linked bots and agents`, Code.FailedPrecondition);
    }
    yield* remote.call(method, request, signal);
  }
  /** Why a peer's threads cannot be reached, in the words the UI shows. */
  async unavailable(nodeId: string): Promise<ConnectError> {
    const peer = await this.store.computer(nodeId);
    if (!peer) return new ConnectError("That computer is no longer linked", Code.NotFound);
    if (peer.via_node_id && !this.#relayChannel(peer.via_node_id)) {
      const computer = await this.#computerMessage(peer);
      return new ConnectError(computer.unavailableReason, Code.Unavailable);
    }
    const name = peer.display_name || peer.name;
    if (peer.status === "needs_update") return new ConnectError(peer.update_node_id === this.#identity.node_id ? `This computer needs an update to work with ${name}` : `${name} needs an update`, Code.FailedPrecondition);
    if (peer.status === "connected") {
      return this.capabilities(nodeId).length && !this.capabilities(nodeId).includes(REMOTE_THREADS)
        ? new ConnectError(`${name} needs an update to share its threads`, Code.FailedPrecondition)
        : new ConnectError(`${name} is reconnecting. Try again in a moment.`, Code.Unavailable);
    }
    if (peer.status === "pairing_required") return new ConnectError(`${name} must be paired again`, Code.FailedPrecondition);
    const time = await this.#time(new Date(peer.status_since));
    return new ConnectError(`${name} ${STATE_TEXT[peer.status] ?? "is unreachable"} ${peer.status === "unreachable" || peer.status === "updating" ? "since" : "at"} ${time}`, Code.Unavailable);
  }
  async #time(since: Date) {
    const zone = await this.options.zone?.().catch(() => undefined) || "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(since) === new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    return new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", minute: "2-digit", ...(!today && { day: "numeric", month: "short" }) }).format(since);
  }

  async announce(state: string) {
    if (!["updating", "sleeping", "shutting_down", "connected"].includes(state)) throw new ConnectError("Unknown presence state", Code.InvalidArgument);
    this.#announced = state;
    this.#broadcast({ body: { case: "presence", value: { state, announcedAtMs: BigInt(Date.now()) } } });
    // Allow queued control frames to reach the socket before a lifecycle stop.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (state === "sleeping") this.#paused = true;
    if (state === "connected") { this.#paused = false; await this.#listen(); await this.#tick(); }
  }
  async close(state = "shutting_down") {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.announce(state === "shutting_down" && this.#announced === "updating" ? "updating" : state);
    clearInterval(this.#timer);
    this.shared?.close();
    this.relay.close();
    await this.#lan?.close(); this.#lan = undefined;
    for (const controller of this.#dialing.values()) controller.abort();
    for (const controller of this.#mirroring.values()) controller.abort();
    for (const controller of this.#botMirroring.values()) controller.abort();
    for (const set of this.#active.values()) for (const c of set) c.close();
    await this.#listener?.close(); this.#listener = undefined;
    await Promise.allSettled(this.#tasks);
  }
}
