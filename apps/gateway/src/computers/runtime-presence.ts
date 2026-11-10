import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import { CANOPY_VERSION } from "@canopy/domain/release/version";

import { COMPUTER_LINK_PROTOCOL, MIN_COMPUTER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";

import {
  AGENT_BUS,
  CONFIG_SYNC,
  LAN_ROUTES,
  MOVE_ITEMS,
  REMOTE_APP_UPDATE,
  RELAY,
  REMOTE_BOTS,
  REMOTE_BOT_COMPOSER,
  REMOTE_THREADS,
  REMOTE_BRANCH_SWITCH,
  THREAD_MIRROR,
  THREAD_MIRROR_DELTA,
  THREAD_WATCH_LIVENESS,
  THREAD_WATCH_COALESCE,
  INLINE_ATTACHMENTS,
  STEER_ATTACHMENTS,
} from "@canopy/domain/computers";

import { certificateIdentity, computerName, linkAddress } from "./identity.ts";

import { computersBroadcast, computersPulse, computersTick } from "./runtime-connection.ts";
import { computersState } from "./runtime-context.ts";
import { computersAdvertise, computersDiscovery, computersLanState } from "./runtime-lan.ts";
import { computersEmit } from "./runtime-mirrors.ts";
import { computersComputerMessage } from "./runtime-remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { errorCode } from "../network/listener.ts";
import { discoverCertificate, linkClient } from "./transport.ts";
import { refreshConfigGroup, setConfigSharing } from "./runtime-config.ts";
import { configNotices } from "../config-sync/notices.ts";
import { followWorkerRecords } from "./runtime-workers.ts";
import { RESTART_PRESENCE } from "@canopy/domain/computer-presence";
import { PEER_HEARTBEAT_MS } from "./timing.ts";

/** A direct partner connected now that receives moves (never through a relay). */
export function computersMovable(hostContext: LinkedComputers, nodeId: string) {
  return (
    Boolean(hostContext.moves) &&
    !hostContext.relay.entries.has(nodeId) &&
    hostContext.reachable().includes(nodeId) &&
    hostContext.capabilities(nodeId).includes(MOVE_ITEMS)
  );
}

export interface ComputersPresenceMethods {
  hello(): link.NodeHello;
  start(): Promise<void>;
  snapshot(): Promise<ui.ComputersSnapshot>;
  createPairing(shareConfig?: boolean): Promise<ui.ComputerPairing>;
  pair(address: string, code: string, shareConfig?: boolean): Promise<ui.ComputersSnapshot>;
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
        RESTART_PRESENCE,
        LAN_ROUTES,
        ...(this.options.serve
          ? [
              REMOTE_THREADS,
              "project_workspaces",
              "git_clone_progress_v1",
              "workspace_copy_v1",
              "workspace_copy_scope_v2",
              REMOTE_BRANCH_SWITCH,
              "remote_worktrees",
              THREAD_MIRROR,
              THREAD_MIRROR_DELTA,
              THREAD_WATCH_LIVENESS,
              THREAD_WATCH_COALESCE,
              REMOTE_BOTS,
              REMOTE_BOT_COMPOSER,
              AGENT_BUS,
              RELAY,
              INLINE_ATTACHMENTS,
              STEER_ATTACHMENTS,
            ]
          : []),
        ...(this.config ? [CONFIG_SYNC] : []),
        ...(this.moves ? [MOVE_ITEMS] : []),
        ...(this.options.updates ? [REMOTE_APP_UPDATE] : []),
      ],
    });
  },

  async start(this: LinkedComputers) {
    this[computersState].identity = await this.store.identity();

    for (const peer of await this.store.peers()) this[computersState].capabilities.set(peer.node_id, peer.capabilities);
    await this.config?.start();

    if (this.config && this.options.core)
      this[computersState].workerRecords = followWorkerRecords(this.config, this.options.core.hub);
    await refreshConfigGroup(this);
    // A process restart never claims an old connection is still alive.
    await this.store.query(
      "UPDATE computer_peers SET status='unreachable',status_since=now() WHERE owner_user_id=$1::uuid AND status IN ('connected','needs_update','inactive')",
      [this.store.owner],
    );
    await this.relay.load();
    await this.redirects.load();
    await this.moves?.load();
    this[computersState].unsubscribe = this.options.network.onChange(() => computersAdvertise(this));
    await computersDiscovery(this);
    this[computersState].timer = setInterval(() => {
      computersPulse(this);
      void computersTick(this).catch(() => {});
    }, this.options.heartbeatMs ?? PEER_HEARTBEAT_MS);
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
      listenerEnabled: this.options.network.listening,
      listenerAvailable: true,
      lanDiscoveryEnabled: this[computersState].identity.lan_discovery,
      lanDiscoveryState: lan.state,
      lanDiscoveryNote: lan.note,
      configGroup: await refreshConfigGroup(this),
      configNotices: this.config ? await configNotices(this.config) : [],
    });
  },

  async createPairing(this: LinkedComputers, shareConfig = true) {
    if (!this.options.network.listening)
      throw new ConnectError(
        "Turn on network access first, so the other computer can connect",
        Code.FailedPrecondition,
      );

    if (!this.options.network.origins().length)
      throw new ConnectError(
        "This computer has no network address right now. Connect to a network or add a hostname in Network access.",
        Code.FailedPrecondition,
      );

    return create(
      ui.ComputerPairingSchema,
      await this.store.invitation(
        this[computersState].identity.fingerprint,
        this.options.network.origins(),
        shareConfig,
      ),
    );
  },

  async pair(this: LinkedComputers, address: string, code: string, shareConfig = true) {
    address = linkAddress(address);
    const raw = code.replace(/[\s-]/g, "").toLowerCase();

    if (!/^[a-f0-9]{96}$/.test(raw))
      throw new ConnectError("Paste the complete pairing code from the other computer", Code.InvalidArgument);
    const started = performance.now();

    let certificate: string;

    try {
      certificate = await discoverCertificate(address, raw.slice(0, 64), this[computersState].identity);
    } catch (error) {
      // On macOS a refused local network permission looks like an unreachable computer.
      const cause = error instanceof ConnectError && error.cause instanceof Error ? errorCode(error.cause) : "";
      const help = this.options.network.unreachable(new URL(address).hostname, cause);

      throw help ? new ConnectError(help, Code.Unavailable) : error;
    }

    this.options.network.reached();
    const latency = performance.now() - started;

    if (certificateIdentity(certificate).nodeId === this[computersState].identity.node_id)
      throw new ConnectError("Choose another computer", Code.InvalidArgument);

    const response = await linkClient(address, certificate, this[computersState].identity).pair(
      { secret: raw.slice(64), hello: this.hello(), shareConfig },
      { timeoutMs: 10_000 },
    );

    if (!response.hello) throw new ConnectError("The computer did not return an identity", Code.Unauthenticated);
    await this.store.remember(response.hello, certificate, address, latency);
    await this.store.query(
      `UPDATE computer_peers SET share_config=$3,peer_share_config=$4,share_config_revision=0,peer_share_config_revision=0
      WHERE owner_user_id=$1::uuid AND node_id=$2`,
      [this.store.owner, response.hello.nodeId, shareConfig, response.shareConfig ?? true],
    );
    this[computersState].retry.delete(response.hello.nodeId);
    this.reads.connected(response.hello.nodeId);
    void this[computersState].lan?.refresh().catch(() => {});
    void computersTick(this).catch(() => {});

    return this.snapshot();
  },

  async manage(this: LinkedComputers, request: ui.ComputerOperationRequest) {
    const { nodeId, action } = request;

    if (action === "share_config") {
      await setConfigSharing(this, nodeId, request.enabled);
      computersEmit(this, nodeId);
    } else if (action === "share_onward") {
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
        this.reads.connected(nodeId);
      } else if (!(await this[computersState].routes.remove(nodeId, address)))
        throw new ConnectError("Route not found", Code.NotFound);
      computersEmit(this, nodeId);
    } else if (action === "presence") await this.announce(request.name);
    else throw new ConnectError("Unknown computer operation", Code.InvalidArgument);

    return this.snapshot();
  },
};
