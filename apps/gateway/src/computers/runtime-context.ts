import { create, type MessageInitShape } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import type { GatewayCore } from "../core/core.ts";

import { RemoteCalls, type RemoteServe } from "./remote.ts";

import { type MoveHost } from "./moves.ts";

import { type SharedHost } from "../config-sync/host.ts";

import { ComputerStore, type PeerRow } from "./store.ts";

import { Routes, type RouteRow } from "./routes.ts";

import { LanDiscovery, type LanTransportFactory } from "./lan.ts";

import type { NetworkAccess } from "../network/network.ts";

export type Connection = {
  send: (frame: MessageInitShape<typeof link.LinkFrameSchema>) => void;
  close: () => void;
  seen: number;
  /** When this link last wrote the peer's last_seen. */
  stored?: number;
  ready: boolean;
  protocol?: number;
  capabilities?: Set<string>;
  remote?: RemoteCalls;
  relayReady?: boolean;
  configReady?: boolean;
  configReceived?: boolean;
};

export type Options = {
  store: ComputerStore;
  /** The network access listener this computer's link service answers on, and its addresses. */
  network: NetworkAccess;
  minProtocol?: number;
  maxProtocol?: number;
  heartbeatMs?: number;
  /** Serves linked computers' calls on this computer's threads (stage 2). Without it the capability is not offered. */
  serve?: RemoteServe;
  /** Configuration shared with linked computers. Without it the capability is not offered. */
  shared?: SharedHost;
  /** The owner's IANA zone for "unreachable since 19:42". */
  zone?: () => Promise<string | undefined>;
  /** Overrides the advertised capabilities (tests of older computers). */
  capabilities?: string[];
  /** Local network discovery of linked computers (stage 6). Without it discovery is unavailable. */
  discovery?: {
    transport: LanTransportFactory;
    unavailable?: string;
    now?: () => number;
    queryIntervalMs?: number;
    testIntervalMs?: number;
  };
  /** Moving threads and bots to and from directly linked computers (stage 8). Without it the capability is not offered. */
  core?: GatewayCore;
  /** Tests: interrupts a move at a phase. */
  moveHook?: MoveHost["hook"];
};

/** A peer changed (presence, name, capabilities) or was removed. */
export type ComputerChange = { nodeId: string; removed: boolean };

export const ms = (date: Date | null) => (date ? BigInt(new Date(date).getTime()) : 0n);

export const peerMessage = (p: PeerRow, capabilities: string[] = [], routes: RouteRow[] = []) =>
  create(ui.LinkedComputerSchema, {
    nodeId: p.node_id,
    name: p.name,
    displayName: p.display_name,
    addresses: p.addresses,
    fingerprint: p.fingerprint,
    appVersion: p.app_version,
    minProtocol: p.min_protocol,
    maxProtocol: p.max_protocol,
    status: p.status,
    statusSinceMs: ms(p.status_since),
    lastSeenMs: ms(p.last_seen),
    linkedAtMs: ms(p.linked_at),
    updateNodeId: p.update_node_id,
    capabilities,
    routes: routes.map((r) => ({
      address: r.address,
      source: r.source,
      addedAtMs: ms(r.added_at),
      lastSuccessMs: ms(r.last_success),
      lastFailureMs: ms(r.last_failure),
      latencyMs: r.latency_ms ?? 0,
    })),
  });

export const WILDCARD = new Set(["0.0.0.0", "::"]);

/** last_seen is shown, not used for liveness: a heartbeat writes it at most this often. */
export const LAST_SEEN_WRITE_MS = 5000;

export const STATE_TEXT = new Map(
  Object.entries({
    updating: "is updating",
    sleeping: "went to sleep",
    shutting_down: "shut down",
    unreachable: "is unreachable",
    pairing_required: "must be paired again",
  }),
);

export async function computerGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError(
      "Computer link operation failed. Check the address, code and Network access settings.",
      Code.FailedPrecondition,
    );
  }
}

export const computersState: unique symbol = Symbol("LinkedComputers state");

export class LinkedComputersState {
  identity!: Awaited<ReturnType<ComputerStore["identity"]>>;

  unsubscribe: (() => void) | undefined;

  timer: ReturnType<typeof setInterval> | undefined;

  stopped = false;

  paused = false;

  announced = "connected";

  active = new Map<string, Set<Connection>>();

  dialing = new Map<string, AbortController>();

  tasks = new Set<Promise<void>>();

  retry = new Map<string, { at: number; delay: number }>();

  tickRunning = false;

  pulsed = 0;

  listeners = new Set<(change: ComputerChange) => void>();

  names = new Map<string, string>();

  capabilities = new Map<string, string[]>();

  mirroring = new Map<string, AbortController>();

  botMirroring = new Map<string, AbortController>();

  configWatching = new Map<string, AbortController>();
  configServing = new Map<string, Set<AbortController>>();

  routes!: Routes;

  lan: LanDiscovery | undefined;

  lanError = "";

  advertised: string[] = [];

  network = "";

  tested = new Map<string, number>();

  testBudget = { start: 0, count: 0 };
}
