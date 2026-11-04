import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import { CANOPY_VERSION } from "@canopy/domain/release/version";

import { COMPUTER_LINK_PROTOCOL, MIN_COMPUTER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";

import {
  AGENT_BUS,
  LAN_ROUTES,
  MOVE_ITEMS,
  RELAY,
  REMOTE_BOTS,
  REMOTE_THREADS,
  SHARED_CONFIG,
  THREAD_MIRROR,
} from "@canopy/domain/computers";

import { certificateIdentity, computerName, linkAddress } from "./identity.ts";

import { computersBroadcast, computersPulse, computersTick } from "./runtime-connection.ts";
import { computersState, WILDCARD } from "./runtime-context.ts";
import { computersAdvertise, computersDiscovery, computersLanState } from "./runtime-lan.ts";
import { computersEmit } from "./runtime-mirrors.ts";
import { computersComputerMessage } from "./runtime-remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { discoverCertificate, linkClient, listenLink } from "./transport.ts";

/** A direct partner connected now that receives moves (never through a relay). */
export function computersMovable(hostContext: LinkedComputers, nodeId: string) {
  return (
    Boolean(hostContext.moves) &&
    !hostContext.relay.entries.has(nodeId) &&
    hostContext.reachable().includes(nodeId) &&
    hostContext.capabilities(nodeId).includes(MOVE_ITEMS)
  );
}

export function computersSharesConfig(hostContext: LinkedComputers) {
  return Boolean(hostContext.shared) && hostContext.hello().capabilities.includes(SHARED_CONFIG);
}

export async function computersListen(hostContext: LinkedComputers) {
  if (
    hostContext[computersState].listener ||
    !hostContext.options.host ||
    !hostContext[computersState].identity.listener_enabled ||
    hostContext[computersState].stopped ||
    hostContext[computersState].paused
  )
    return;
  hostContext[computersState].listener = await listenLink({
    host: hostContext.options.host,
    port: hostContext.options.port ?? 0,
    identity: hostContext[computersState].identity,
    routes: hostContext.routes,
  });
  const host = hostContext.options.host.includes(":") ? `[${hostContext.options.host}]` : hostContext.options.host;
  hostContext[computersState].addresses =
    hostContext.options.addresses?.map(linkAddress) ??
    (WILDCARD.has(hostContext.options.host) ? [] : [`https://${host}:${hostContext[computersState].listener.port}`]);
  computersAdvertise(hostContext);
}

export interface ComputersPresenceMethods {
  hello(): link.NodeHello;
  start(): Promise<void>;
  snapshot(): Promise<ui.ComputersSnapshot>;
  createPairing(): Promise<ui.ComputerPairing>;
  pair(address: string, code: string): Promise<ui.ComputersSnapshot>;
  manage(request: ui.ComputerOperationRequest): Promise<ui.ComputersSnapshot>;
}

export const computersPresenceMethods: ComputersPresenceMethods = {
  hello(this: LinkedComputers) {
    return create(link.NodeHelloSchema, {
      nodeId: this[computersState].identity.node_id,
      name: this[computersState].identity.name,
      addresses: this[computersState].advertised,
      appVersion: CANOPY_VERSION,
      minProtocol: this.options.minProtocol ?? MIN_COMPUTER_LINK_PROTOCOL,
      maxProtocol: this.options.maxProtocol ?? COMPUTER_LINK_PROTOCOL,
      capabilities: this.options.capabilities ?? [
        "presence",
        "unlink",
        LAN_ROUTES,
        ...(this.options.serve ? [REMOTE_THREADS, THREAD_MIRROR, REMOTE_BOTS, AGENT_BUS, RELAY] : []),
        ...(this.shared ? [SHARED_CONFIG] : []),
        ...(this.moves ? [MOVE_ITEMS] : []),
      ],
    });
  },

  async start(this: LinkedComputers) {
    this[computersState].identity = await this.store.identity();

    for (const peer of await this.store.peers()) this[computersState].capabilities.set(peer.node_id, peer.capabilities);
    await this.shared?.load();
    // A process restart never claims an old connection is still alive.
    await this.store.query(
      "UPDATE computer_peers SET status='unreachable',status_since=now() WHERE owner_user_id=$1::uuid AND status IN ('connected','needs_update')",
      [this.store.owner],
    );
    await this.relay.load();
    await this.redirects.load();
    await this.moves?.load();
    await computersListen(this);
    await computersDiscovery(this);
    this[computersState].timer = setInterval(() => {
      computersPulse(this);
      void computersTick(this).catch(() => {});
    }, this.options.heartbeatMs ?? 5000);
    await computersTick(this);
  },

  async snapshot(this: LinkedComputers) {
    const routes = await this[computersState].routes.list();
    const lan = computersLanState(this);

    return create(ui.ComputersSnapshotSchema, {
      self: {
        nodeId: this[computersState].identity.node_id,
        name: this[computersState].identity.name,
        fingerprint: this[computersState].identity.fingerprint,
        addresses: this[computersState].advertised,
        appVersion: CANOPY_VERSION,
        minProtocol: this.hello().minProtocol,
        maxProtocol: this.hello().maxProtocol,
      },
      peers: await Promise.all(
        (await this.store.computers()).map((p) =>
          computersComputerMessage(
            this,
            p,
            routes.filter((r) => r.node_id === p.node_id),
          ),
        ),
      ),
      listenerEnabled: Boolean(this[computersState].listener),
      listenerAvailable: Boolean(this.options.host),
      lanDiscoveryEnabled: this[computersState].identity.lan_discovery,
      lanDiscoveryState: lan.state,
      lanDiscoveryNote: lan.note,
    });
  },

  async createPairing(this: LinkedComputers) {
    if (!this[computersState].listener || !this[computersState].addresses.length)
      throw new ConnectError(
        "Enable the link listener and configure at least one advertised address first",
        Code.FailedPrecondition,
      );

    return create(
      ui.ComputerPairingSchema,
      await this.store.invitation(this[computersState].identity.fingerprint, this[computersState].addresses),
    );
  },

  async pair(this: LinkedComputers, address: string, code: string) {
    address = linkAddress(address);
    const raw = code.replace(/[\s-]/g, "").toLowerCase();

    if (!/^[a-f0-9]{96}$/.test(raw))
      throw new ConnectError("Paste the complete pairing code from the other computer", Code.InvalidArgument);
    const started = performance.now();
    const certificate = await discoverCertificate(address, raw.slice(0, 64), this[computersState].identity);
    const latency = performance.now() - started;

    if (certificateIdentity(certificate).nodeId === this[computersState].identity.node_id)
      throw new ConnectError("Choose another computer", Code.InvalidArgument);

    const response = await linkClient(address, certificate, this[computersState].identity).pair(
      { secret: raw.slice(64), hello: this.hello() },
      { timeoutMs: 10_000 },
    );

    if (!response.hello) throw new ConnectError("The computer did not return an identity", Code.Unauthenticated);
    await this.store.remember(response.hello, certificate, address, latency);
    this[computersState].retry.delete(response.hello.nodeId);
    void this[computersState].lan?.refresh().catch(() => {});
    void computersTick(this).catch(() => {});

    return this.snapshot();
  },

  async manage(this: LinkedComputers, request: ui.ComputerOperationRequest) {
    const { nodeId, action } = request;

    if (action === "share_onward") {
      await this.relay.set(nodeId, request.shareOnwardNodeIds);
      computersEmit(this, nodeId);
    } else if (action === "rename") {
      const name = computerName(request.name);

      if (!nodeId || nodeId === this[computersState].identity.node_id) {
        await this.store.query("UPDATE computer_identity SET name=$2 WHERE owner_user_id=$1::uuid", [
          this.store.owner,
          name,
        ]);
        this[computersState].identity.name = name;
        computersBroadcast(this, { body: { case: "hello", value: this.hello() } });
      } else {
        if (!(await this.store.peer(nodeId))) throw new ConnectError("Computer not found", Code.NotFound);
        await this.store.query(
          "UPDATE computer_peers SET display_name=$3 WHERE owner_user_id=$1::uuid AND node_id=$2",
          [this.store.owner, nodeId, name],
        );
        this[computersState].names.set(nodeId, name);
        computersEmit(this, nodeId);
      }
    } else if (action === "unlink") {
      if (!(await this.store.peer(nodeId))) throw new ConnectError("Computer not found", Code.NotFound);
      // An unfinished move with this computer settles first: one home stays (stage 8).
      await this.moves?.unlinked(nodeId);
      // Persist revocation before releasing trust. A peer offline now learns it
      // through the authenticated control channel on its next reconnect.
      await this.store.remove(nodeId, true);
      await this.relay.refresh();
      computersEmit(this, nodeId, true);
      this.shared?.changed();

      for (const connection of this[computersState].active.get(nodeId) ?? [])
        connection.send({ body: { case: "unlinked", value: {} } });
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (const connection of this[computersState].active.get(nodeId) ?? []) connection.close();
      this[computersState].dialing.get(nodeId)?.abort();
      this[computersState].retry.delete(nodeId);
      void this[computersState].lan?.refresh().catch(() => {});
    } else if (action === "revoke_pairing") {
      await this.store.query(
        "UPDATE computer_pairings SET revoked_at=now() WHERE owner_user_id=$1::uuid AND used_at IS NULL",
        [this.store.owner],
      );
    } else if (action === "listener") {
      if (!this.options.host)
        throw new ConnectError(
          "Enable Allow other machines to connect in desktop settings, or configure CANOPY_LINK_HOST",
          Code.FailedPrecondition,
        );

      if (request.enabled) {
        this[computersState].identity.listener_enabled = true;
        await computersListen(this);
      } else {
        this[computersState].identity.listener_enabled = false;
        await this[computersState].listener?.close();
        this[computersState].listener = undefined;
        this[computersState].addresses = [];
        computersAdvertise(this);
      }

      await this.store.query("UPDATE computer_identity SET listener_enabled=$2 WHERE owner_user_id=$1::uuid", [
        this.store.owner,
        request.enabled,
      ]);
    } else if (action === "lan_discovery") {
      await this.store.query("UPDATE computer_identity SET lan_discovery=$2 WHERE owner_user_id=$1::uuid", [
        this.store.owner,
        request.enabled,
      ]);
      this[computersState].identity.lan_discovery = request.enabled;

      // Off: nothing is announced or asked for, and paths found on a network are forgotten.
      if (!request.enabled) await this[computersState].routes.forgetLan();
      await computersDiscovery(this);
    } else if (action === "add_route" || action === "remove_route") {
      if (!(await this.store.peer(nodeId))) throw new ConnectError("Computer not found", Code.NotFound);
      const address = linkAddress(request.address);

      if (action === "add_route") {
        await this[computersState].routes.add(nodeId, [address], "manual");
        this[computersState].retry.delete(nodeId);
      } else if (!(await this[computersState].routes.remove(nodeId, address)))
        throw new ConnectError("Route not found", Code.NotFound);
      computersEmit(this, nodeId);
    } else if (action === "presence") await this.announce(request.name);
    else throw new ConnectError("Unknown computer operation", Code.InvalidArgument);

    return this.snapshot();
  },
};
