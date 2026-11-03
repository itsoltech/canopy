import { create, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { AsyncChannel } from "@canopy/transport";
import { MIN_COMPUTER_LINK_PROTOCOL, COMPUTER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";
import { NODE_REF_LENGTH, REMOTE_THREADS } from "@canopy/domain/computers";
import { RemoteCalls, type RemoteServe } from "./remote.ts";
import { ComputerStore, type PeerRow } from "./store.ts";
import { certificateIdentity, computerName, linkAddress } from "./identity.ts";
import { discoverCertificate, linkClient, listenLink, remoteCertificate, type LinkIdentity } from "./transport.ts";

type Connection = { send: (frame: MessageInitShape<typeof link.LinkFrameSchema>) => void; close: () => void; seen: number; ready: boolean;
  protocol?: number; capabilities?: Set<string>; remote?: RemoteCalls };
type Options = { store: ComputerStore; host?: string; port?: number; addresses?: string[]; minProtocol?: number; maxProtocol?: number; heartbeatMs?: number;
  /** Serves linked computers' calls on this computer's threads (stage 2). Without it the capability is not offered. */
  serve?: RemoteServe;
  /** The owner's IANA zone for "unreachable since 19:42". */
  zone?: () => Promise<string | undefined>;
  /** Overrides the advertised capabilities (tests of older computers). */
  capabilities?: string[] };
/** A peer changed (presence, name, capabilities) or was removed. */
export type ComputerChange = { nodeId: string; removed: boolean };
const ms = (date: Date | null) => date ? BigInt(new Date(date).getTime()) : 0n;
const peerMessage = (p: PeerRow, capabilities: string[] = []) => create(ui.LinkedComputerSchema, { nodeId: p.node_id, name: p.name, displayName: p.display_name,
  addresses: p.addresses, fingerprint: p.fingerprint, appVersion: p.app_version, minProtocol: p.min_protocol, maxProtocol: p.max_protocol,
  status: p.status, statusSinceMs: ms(p.status_since), lastSeenMs: ms(p.last_seen), linkedAtMs: ms(p.linked_at), updateNodeId: p.update_node_id, capabilities });
const STATE_TEXT: Record<string, string> = { updating: "is updating", sleeping: "went to sleep", shutting_down: "shut down", unreachable: "is unreachable", pairing_required: "must be paired again" };

export async function computerGuard<A>(run: () => Promise<A>): Promise<A> {
  try { return await run(); } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Computer link operation failed. Check the address, code and listener settings.", Code.FailedPrecondition);
  }
}

/** Only stage-1 control messages are implemented. No user work is ever queued. */
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
  constructor(readonly options: Options) {}
  get store() { return this.options.store; }
  get identity(): LinkIdentity { return this.#identity; }
  get addresses() { return this.#addresses; }
  hello() { return create(link.NodeHelloSchema, { nodeId: this.#identity.node_id, name: this.#identity.name, addresses: this.#addresses,
    appVersion: CANOPY_VERSION, minProtocol: this.options.minProtocol ?? MIN_COMPUTER_LINK_PROTOCOL, maxProtocol: this.options.maxProtocol ?? COMPUTER_LINK_PROTOCOL,
    capabilities: this.options.capabilities ?? ["presence", "unlink", ...(this.options.serve ? [REMOTE_THREADS] : [])] }); }
  async start() {
    this.#identity = await this.store.identity();
    // A process restart never claims an old connection is still alive.
    await this.store.query("UPDATE computer_peers SET status='unreachable',status_since=now() WHERE owner_user_id=$1::uuid AND status IN ('connected','needs_update')", [this.store.owner]);
    await this.#listen();
    this.#timer = setInterval(() => { void this.#tick().catch(() => {}); }, this.options.heartbeatMs ?? 5000);
    await this.#tick();
  }
  async #listen() {
    if (this.#listener || !this.options.host || !this.#identity.listener_enabled || this.#stopped || this.#paused) return;
    this.#listener = await listenLink({ host: this.options.host, port: this.options.port ?? 0, identity: this.#identity, routes: this.routes });
    const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
    this.#addresses = this.options.addresses?.map(linkAddress) ?? (this.options.host === "0.0.0.0" || this.options.host === "::" ? [] : [`https://${host}:${this.#listener.port}`]);
  }
  routes = (router: ConnectRouter) => router.service(link.ComputerLinkService, {
    pair: async (request, context) => computerGuard(async () => {
      if (!request.hello || request.hello.nodeId === this.#identity.node_id) throw new ConnectError("Choose another computer", Code.InvalidArgument);
      await this.store.pair(request.secret, request.hello, context.values.get(remoteCertificate));
      for (const c of this.#active.get(request.hello.nodeId) ?? []) c.close();
      this.#retry.delete(request.hello.nodeId);
      return create(link.PairResponseSchema, { hello: this.hello() });
    }),
    connect: (request, context) => this.#accept(request, context),
  });
  async snapshot() {
    return create(ui.ComputersSnapshotSchema, { self: { nodeId: this.#identity.node_id, name: this.#identity.name, fingerprint: this.#identity.fingerprint,
      addresses: this.#addresses, appVersion: CANOPY_VERSION, minProtocol: this.hello().minProtocol, maxProtocol: this.hello().maxProtocol },
      peers: (await this.store.peers()).map((p) => peerMessage(p, this.capabilities(p.node_id))), listenerEnabled: Boolean(this.#listener), listenerAvailable: Boolean(this.options.host) });
  }
  async createPairing() {
    if (!this.#listener || !this.#addresses.length) throw new ConnectError("Enable the link listener and configure at least one advertised address first", Code.FailedPrecondition);
    return create(ui.ComputerPairingSchema, await this.store.invitation(this.#identity.fingerprint, this.#addresses));
  }
  async pair(address: string, code: string) {
    address = linkAddress(address);
    const raw = code.replace(/[\s-]/g, "").toLowerCase();
    if (!/^[a-f0-9]{96}$/.test(raw)) throw new ConnectError("Paste the complete pairing code from the other computer", Code.InvalidArgument);
    const certificate = await discoverCertificate(address, raw.slice(0, 64), this.#identity);
    if (certificateIdentity(certificate).nodeId === this.#identity.node_id) throw new ConnectError("Choose another computer", Code.InvalidArgument);
    const response = await linkClient(address, certificate, this.#identity).pair({ secret: raw.slice(64), hello: this.hello() }, { timeoutMs: 10_000 });
    if (!response.hello) throw new ConnectError("The computer did not return an identity", Code.Unauthenticated);
    await this.store.remember(response.hello, certificate, address);
    this.#retry.delete(response.hello.nodeId);
    void this.#tick().catch(() => {});
    return this.snapshot();
  }
  async manage(request: ui.ComputerOperationRequest) {
    const { nodeId, action } = request;
    if (action === "rename") {
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
      this.#emit(nodeId, true);
      for (const connection of this.#active.get(nodeId) ?? []) connection.send({ body: { case: "unlinked", value: {} } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const connection of this.#active.get(nodeId) ?? []) connection.close();
      this.#dialing.get(nodeId)?.abort();
      this.#retry.delete(nodeId);
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
      }
      await this.store.query("UPDATE computer_identity SET listener_enabled=$2 WHERE owner_user_id=$1::uuid", [this.store.owner, request.enabled]);
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
      this.#emit(nodeId, true);
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
      await this.store.query(`UPDATE computer_peers SET name=$3,app_version=$4,min_protocol=$5,max_protocol=$6,addresses=$7::jsonb
        WHERE owner_user_id=$1::uuid AND node_id=$2`, [this.store.owner, nodeId, hello.name, hello.appVersion, hello.minProtocol, hello.maxProtocol,
        JSON.stringify([...new Set([...hello.addresses, ...peer.addresses])].slice(0, 16))]);
      connection.protocol = protocol;
      connection.capabilities = new Set(hello.capabilities);
      this.#names.set(nodeId, peer.display_name || hello.name);
      if (protocol && !connection.remote) connection.remote = new RemoteCalls({ send: (f) => connection.send(f), serve: this.options.serve,
        name: () => this.#names.get(nodeId) ?? "The other computer", allowed: async () => Boolean(await this.store.peer(nodeId)) });
      connection.ready = true;
      await this.#status(nodeId, protocol ? "connected" : "needs_update", updateNodeId);
      if (body.case === "hello") {
        connection.send({ body: { case: "welcome", value: { hello: local, protocol, updateNodeId } } });
        if (this.#announced !== "connected") connection.send({ body: { case: "presence", value: { state: this.#announced, announcedAtMs: BigInt(Date.now()) } } });
      }
    } else if (body.case === "presence") {
      if (!["updating", "sleeping", "shutting_down", "connected"].includes(body.value.state)) throw new ConnectError("Unknown presence state", Code.InvalidArgument);
      await this.#status(nodeId, body.value.state === "connected" && peer.update_node_id ? "needs_update" : body.value.state, peer.update_node_id);
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
      for (const peer of await this.store.peers()) {
        if (this.#stopped || this.#paused) break;
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
    } finally { this.#tickRunning = false; }
  }
  async #dial(peer: PeerRow, controller: AbortController) {
    for (const address of peer.addresses) {
      if (controller.signal.aborted || this.#stopped || this.#paused || this.#active.get(peer.node_id)?.size) return;
      const output = new AsyncChannel<link.LinkFrame>();
      const routeController = new AbortController();
      const connection: Connection = { send: (f) => { output.push(create(link.LinkFrameSchema, f)); }, close: () => { output.close(); routeController.abort(); connection.remote?.close(); }, seen: Date.now(), ready: false };
      const release = this.#track(peer.node_id, connection);
      try {
        connection.send({ body: { case: "hello", value: this.hello() } });
        // Queued hello is sent only after verification. No heartbeat may precede it.
        await discoverCertificate(address, peer.fingerprint, this.#identity);
        let greeted = false;
        const deadline = setTimeout(() => { if (!greeted) routeController.abort(); }, 8000);
        try {
          for await (const frame of linkClient(address, peer.certificate, this.#identity).connect(output, { signal: AbortSignal.any([controller.signal, routeController.signal]) })) {
            if (!greeted && !["welcome", "unlinked"].includes(frame.body.case ?? "")) throw new ConnectError("Handshake required", Code.FailedPrecondition);
            if (!greeted && frame.body.case === "welcome") {
              if (this.#announced !== "connected") connection.send({ body: { case: "presence", value: { state: this.#announced, announcedAtMs: BigInt(Date.now()) } } });
            }
            greeted = true; clearTimeout(deadline);
            await this.#receive(peer.node_id, frame, connection);
            if (frame.body.case === "welcome") {
              const current = await this.store.peer(peer.node_id);
              if (current) await this.store.query("UPDATE computer_peers SET addresses=$3::jsonb WHERE owner_user_id=$1::uuid AND node_id=$2", [this.store.owner, peer.node_id, JSON.stringify([address, ...current.addresses.filter((a) => a !== address)])]);
            }
            if (controller.signal.aborted) break;
          }
        } finally { clearTimeout(deadline); }
        if (greeted) { this.#retry.delete(peer.node_id); break; }
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.Unauthenticated) await this.#status(peer.node_id, "pairing_required");
        // A pin mismatch never changes trust. Try other known routes.
      }
      finally { output.close(); await release(); }
    }
    const delay = Math.min(30_000, (this.#retry.get(peer.node_id)?.delay ?? 500) * 2);
    this.#retry.set(peer.node_id, { delay, at: Date.now() + delay + Math.random() * delay / 4 });
  }
  // ------------------------------------------------------------------ stage 2: remote threads

  subscribe(listener: (change: ComputerChange) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #emit(nodeId: string, removed = false) {
    if (removed) this.#names.delete(nodeId);
    for (const listener of this.#listeners) { try { listener({ nodeId, removed }); } catch { /* a subscriber's failure is its own */ } }
  }
  async #status(nodeId: string, status: string, updateNodeId = "") { await this.store.status(nodeId, status, updateNodeId); this.#emit(nodeId); }
  /** Features of the live connections (empty while not connected). */
  capabilities(nodeId: string): string[] {
    const all = new Set<string>();
    for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol) for (const name of c.capabilities ?? []) all.add(name);
    return [...all];
  }
  #channel(nodeId: string) {
    for (const c of this.#active.get(nodeId) ?? []) if (c.ready && c.protocol && c.capabilities?.has(REMOTE_THREADS) && c.remote && !c.remote.closed) return c.remote;
    return undefined;
  }
  /** Peers whose threads this computer can show and act on right now. */
  reachable(): string[] { return [...this.#active.keys()].filter((id) => this.#channel(id)); }
  async computer(nodeId: string) { const peer = await this.store.peer(nodeId); return peer && peerMessage(peer, this.capabilities(nodeId)); }
  /** The linked computer of a qualified id's suffix. */
  async resolve(ref: string): Promise<PeerRow> {
    const peers = ref.length === NODE_REF_LENGTH ? (await this.store.peers()).filter((p) => p.node_id.startsWith(ref)) : [];
    if (peers.length !== 1) throw new ConnectError("That computer is no longer linked", Code.NotFound);
    return peers[0]!;
  }
  /** One call on a peer's home threads. Fails at once when it cannot be delivered; nothing waits for a reconnect. */
  async *remote(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message> {
    const remote = this.#channel(nodeId);
    if (!remote) throw await this.unavailable(nodeId);
    yield* remote.call(method, request, signal);
  }
  /** Why a peer's threads cannot be reached, in the words the UI shows. */
  async unavailable(nodeId: string): Promise<ConnectError> {
    const peer = await this.store.peer(nodeId);
    if (!peer) return new ConnectError("That computer is no longer linked", Code.NotFound);
    const name = peer.display_name || peer.name;
    if (peer.status === "needs_update") return new ConnectError(peer.update_node_id === this.#identity.node_id ? `This computer needs an update to work with ${name}` : `${name} needs an update`, Code.FailedPrecondition);
    if (peer.status === "connected") {
      return this.capabilities(nodeId).length && !this.capabilities(nodeId).includes(REMOTE_THREADS)
        ? new ConnectError(`${name} needs an update to share its threads`, Code.FailedPrecondition)
        : new ConnectError(`${name} is reconnecting. Try again in a moment.`, Code.Unavailable);
    }
    if (peer.status === "pairing_required") return new ConnectError(`${name} must be paired again`, Code.FailedPrecondition);
    const zone = await this.options.zone?.().catch(() => undefined) || "UTC";
    const since = new Date(peer.status_since);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(since) === new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", ...(!today && { day: "numeric", month: "short" }) }).format(since);
    return new ConnectError(`${name} ${STATE_TEXT[peer.status] ?? "is unreachable"} ${peer.status === "unreachable" || peer.status === "updating" ? "since" : "at"} ${time}`, Code.Unavailable);
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
    for (const controller of this.#dialing.values()) controller.abort();
    for (const set of this.#active.values()) for (const c of set) c.close();
    await this.#listener?.close(); this.#listener = undefined;
    await Promise.allSettled(this.#tasks);
  }
}
