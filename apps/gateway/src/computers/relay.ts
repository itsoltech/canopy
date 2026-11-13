import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { RESTART_PRESENCE } from "@canopy/domain/computer-presence";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link } from "@canopy/contracts";
import {
  AGENT_BUS,
  REMOTE_BOTS,
  REMOTE_BOT_COMPOSER,
  REMOTE_THREAD_PANEL,
  REMOTE_THREADS,
  REMOTE_BRANCH_SWITCH,
  THREAD_MIRROR,
  THREAD_RANGES,
  GITHUB_PR,
} from "@canopy/domain/computers";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore, type PeerRow } from "./store.ts";
import { linkedMessage, SERVED, UPDATE_METHODS, WORKER_SETTINGS } from "./remote.ts";
import { GITHUB_METHODS } from "./remote-policy.ts";

// Configuration (which can contain credentials) is deliberately absent, even when
// every participant supports stage 4. Routes and relay itself are never inherited.
const FEATURES = new Set([
  "diagnostics_v1",
  REMOTE_THREADS,
  "remote_worktrees",
  REMOTE_BRANCH_SWITCH,
  THREAD_MIRROR,
  THREAD_RANGES,
  REMOTE_BOTS,
  REMOTE_BOT_COMPOSER,
  REMOTE_THREAD_PANEL,
  AGENT_BUS,
  GITHUB_PR,
]);

// Configuration, worker settings and app updates never cross a relay (docs/linked-computers.md, "Udostępnianie per łącze").
export const RELAY_METHODS = new Set(
  [...SERVED].filter(
    (name) =>
      name !== "WatchConfig" &&
      name !== "GetConfigBlob" &&
      !WORKER_SETTINGS.has(name) &&
      !UPDATE_METHODS.has(name) &&
      !GITHUB_METHODS.has(name),
  ),
);

const NODE = /^[a-f0-9]{64}$/;

const STATES = new Set([
  "connected",
  "unreachable",
  "updating",
  "restarting",
  "sleeping",
  "shutting_down",
  "needs_update",
  "pairing_required",
]);

type Grant = { recipient_node_id: string; home_node_id: string };

const key = (recipient: string, home: string) => `${recipient}:${home}`;
const revoked = () => new ConnectError("Share onward access was revoked", Code.PermissionDenied);

/** Reverse access exists only for already-authorized agent questions/reports.
 * LinkedAgents.receive checks the original call, actor and target at its home. */
export function relayCallback(method: DescMethod, request: Message): boolean {
  return (
    method.name === "CallAgentBus" &&
    ["question", "report"].includes(linkedMessage(link.LinkedAgentCallSchema, request).operation)
  );
}

/** Stage 7 policy and catalog. Indirect peers are mirror owners, never trust pins.
 * All policy/catalog mutations are ordered; no lock is held over a network call. */
export class ComputerRelay {
  entries = new Map<string, PeerRow>();
  grants = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #active = new Set<{ allowed: () => boolean; abort: AbortController }>();
  constructor(
    readonly store: ComputerStore,
    readonly host: {
      self: () => string;
      enabled: (nodeId: string) => boolean;
      send: (nodeId: string, catalog: link.RelayCatalog) => void;
      changed: (nodeId: string, removed: boolean) => void;
    },
  ) {}

  #serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#tail.then(run);
    this.#tail = next.catch(() => {});

    return next;
  }
  async #reload() {
    const previous = this.entries;
    this.entries = new Map((await this.store.computers()).filter((p) => p.via_node_id).map((p) => [p.node_id, p]));

    const grants = await this.store.query<Grant>(
      "SELECT recipient_node_id,home_node_id FROM computer_relay_grants WHERE owner_user_id=$1::uuid",
      [this.store.owner],
    );

    this.grants = new Set(grants.map((g) => key(g.recipient_node_id, g.home_node_id)));
    this.check();

    for (const id of previous.keys()) if (!this.entries.has(id)) this.host.changed(id, true);

    for (const id of this.entries.keys()) this.host.changed(id, false);
  }
  async load() {
    await this.#reload();
  }
  allowed(recipient: string, home: string) {
    return this.grants.has(key(recipient, home)) && this.host.enabled(recipient) && this.host.enabled(home);
  }
  selected(recipient: string) {
    return [...this.grants].flatMap((g) => (g.startsWith(`${recipient}:`) ? [g.slice(recipient.length + 1)] : []));
  }
  /** Abort network work as soon as a policy or reachability predicate stops holding. */
  check() {
    for (const call of this.#active) if (!call.allowed()) call.abort.abort(revoked());
  }
  async *guard(
    allowed: () => boolean,
    signal: AbortSignal,
    run: (signal: AbortSignal) => AsyncIterable<Message>,
  ): AsyncGenerator<Message> {
    const abort = new AbortController();
    const call = { allowed, abort };
    this.#active.add(call);
    const combined = AbortSignal.any([signal, abort.signal]);

    try {
      if (!allowed()) throw revoked();

      for await (const message of run(combined)) {
        combined.throwIfAborted();

        if (!allowed()) throw revoked();
        yield message;
      }

      combined.throwIfAborted();
    } finally {
      this.#active.delete(call);
    }
  }
  close() {
    for (const call of this.#active) call.abort.abort(new ConnectError("Relay disconnected", Code.Unavailable));
  }

  async set(recipient: string, homes: string[]) {
    return this.#serial(async () => {
      if (homes.length > 32 || new Set(homes).size !== homes.length)
        throw new ConnectError("Choose at most 32 different linked computers", Code.InvalidArgument);
      const peers = await this.store.peers();
      const direct = new Map(peers.map((p) => [p.node_id, p]));

      if (!direct.has(recipient)) throw new ConnectError("Choose a direct linked computer", Code.InvalidArgument);

      // Turning off remains possible when a partner is offline or was downgraded.
      for (const home of homes) {
        if (home === recipient || home === this.host.self() || !direct.has(home))
          throw new ConnectError(
            "Share onward only supports other direct partners (one relay hop)",
            Code.InvalidArgument,
          );

        if (!this.host.enabled(recipient) || !this.host.enabled(home))
          throw new ConnectError("All three computers need an update for Share onward", Code.FailedPrecondition);
      }

      const { store } = this;
      await store.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT singleton FROM computer_identity WHERE owner_user_id=${store.owner}::uuid FOR UPDATE`;
              yield* sql`DELETE FROM computer_relay_grants WHERE owner_user_id=${store.owner}::uuid AND recipient_node_id=${recipient}`;

              const total = yield* sql<{
                count: string;
              }>`SELECT count(*) AS count FROM computer_relay_grants WHERE owner_user_id=${store.owner}::uuid`;

              if (Number(total[0]!.count) + homes.length > 32)
                return yield* Effect.fail(
                  new ConnectError("At most 32 onward grants are supported", Code.ResourceExhausted),
                );

              for (const home of homes)
                yield* sql`INSERT INTO computer_relay_grants VALUES (${store.owner}::uuid,${recipient},${home})`;
            }),
          );
        }),
      );
      await this.#reload(); // the durable removal and abort precede the catalogs
      await this.#publish();
    });
  }

  /** Publish on handshake, presence/capability changes, unlink and each heartbeat.
   * The durable revision orders full replacements even across two simultaneous streams. */
  refresh() {
    return this.#serial(async () => {
      await this.#reload();
      await this.#publish();
    });
  }
  async #publish() {
    const peers = await this.store.peers();
    const direct = new Map(peers.map((p) => [p.node_id, p]));

    const rows = await this.store.query<{ relay_revision: string }>(
      "UPDATE computer_identity SET relay_revision=relay_revision+1 WHERE owner_user_id=$1::uuid RETURNING relay_revision",
      [this.store.owner],
    );

    const revision = BigInt(rows[0]!.relay_revision);

    for (const partner of peers) {
      if (!this.host.enabled(partner.node_id)) continue;
      const offered = new Map<string, link.RelayComputer>();

      const add = (id: string, role: string) => {
        const p = direct.get(id);

        if (!p || !this.host.enabled(id)) return;
        const previous = offered.get(id);

        if (previous && previous.role !== role) role = "both";
        offered.set(
          id,
          create(link.RelayComputerSchema, {
            nodeId: id,
            name: p.name,
            appVersion: p.app_version,
            status:
              p.status === "restarting" && !partner.capabilities.includes(RESTART_PRESENCE) ? "updating" : p.status,
            statusSinceMs: BigInt(new Date(p.status_since).getTime()),
            lastSeenMs: p.last_seen ? BigInt(new Date(p.last_seen).getTime()) : 0n,
            capabilities:
              role === "origin"
                ? [AGENT_BUS]
                : p.capabilities.filter((c) => FEATURES.has(c) && partner.capabilities.includes(c)),
            role,
          }),
        );
      };

      for (const g of this.grants) {
        const [recipient, home] = g.split(":");

        if (recipient === partner.node_id && home) add(home, "home");

        if (home === partner.node_id && recipient) add(recipient, "origin");
      }

      this.host.send(partner.node_id, create(link.RelayCatalogSchema, { revision, computers: [...offered.values()] }));
    }
  }

  receive(via: string, catalog: link.RelayCatalog) {
    return this.#serial(async () => {
      if (catalog.computers.length > 64 || !catalog.revision)
        throw new ConnectError("Invalid relay catalog", Code.InvalidArgument);
      const ids = new Set<string>();

      for (const p of catalog.computers) {
        if (
          !NODE.test(p.nodeId) ||
          p.nodeId === via ||
          p.nodeId === this.host.self() ||
          ids.has(p.nodeId) ||
          !["home", "origin", "both"].includes(p.role) ||
          !STATES.has(p.status) ||
          !p.name.trim() ||
          p.name.length > 100 ||
          p.appVersion.length > 100 ||
          p.capabilities.length > 32 ||
          p.capabilities.some((c) => !/^[a-z][a-z0-9_]{0,63}$/.test(c)) ||
          p.statusSinceMs <= 0n ||
          p.statusSinceMs > BigInt(Date.now() + 60_000) ||
          p.lastSeenMs < 0n ||
          p.lastSeenMs > BigInt(Date.now() + 60_000)
        )
          throw new ConnectError("Invalid relay computer", Code.InvalidArgument);
        ids.add(p.nodeId);
      }

      const { store } = this;
      await store.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const peer = yield* sql<{
                relay_revision: string;
              }>`SELECT relay_revision FROM computer_peers WHERE owner_user_id=${store.owner}::uuid AND node_id=${via} AND via_node_id IS NULL FOR UPDATE`;

              if (!peer.length || BigInt(peer[0]!.relay_revision) >= catalog.revision) return;
              yield* sql`DELETE FROM computer_peers WHERE owner_user_id=${store.owner}::uuid AND via_node_id=${via} AND node_id<>ALL(${[...ids]}::text[])`;

              for (const p of catalog.computers) {
                if (p.role === "origin") {
                  // Losing public access while the reverse grant remains must still
                  // purge mirrors and detach references. An informational row is new.
                  yield* sql`DELETE FROM computer_peers WHERE owner_user_id=${store.owner}::uuid AND node_id=${p.nodeId} AND via_node_id=${via} AND relay_role<>'origin'`;
                } else if (p.role === "home") {
                  // Only inbound authority was removed. Outgoing references remain.
                  yield* sql`UPDATE computer_agent_calls SET detached=true,report_status='dropped' WHERE owner_user_id=${store.owner}::uuid AND peer_node_id=${p.nodeId} AND direction='incoming'
                AND EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=${store.owner}::uuid AND node_id=${p.nodeId} AND via_node_id=${via} AND relay_role IN ('origin','both'))`;
                  yield* sql`UPDATE threads SET remote_parent_detached=true WHERE owner_user_id=${store.owner}::uuid AND remote_parent_ref LIKE ${`%~${p.nodeId.slice(0, 16)}`}
                AND EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=${store.owner}::uuid AND node_id=${p.nodeId} AND via_node_id=${via} AND relay_role IN ('origin','both'))`;
                }

                // A direct pin always wins. For multiple relays the lexically first
                // advertising relay wins; no chain is ever represented as a partner.
                yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,app_version,status,status_since,last_seen,capabilities,via_node_id,relay_role)
              VALUES (${store.owner}::uuid,${p.nodeId},${p.name},'','',${p.appVersion},${p.status},${new Date(Number(p.statusSinceMs))},${p.lastSeenMs ? new Date(Number(p.lastSeenMs)) : null},${JSON.stringify(p.capabilities)}::jsonb,${via},${p.role})
              ON CONFLICT(owner_user_id,node_id) DO UPDATE SET name=excluded.name,app_version=excluded.app_version,status=excluded.status,
                status_since=excluded.status_since,last_seen=excluded.last_seen,capabilities=excluded.capabilities,via_node_id=excluded.via_node_id,relay_role=excluded.relay_role
              WHERE computer_peers.via_node_id IS NOT NULL AND (computer_peers.via_node_id=${via}
                OR (computer_peers.relay_role='origin' AND excluded.relay_role<>'origin')
                OR (computer_peers.via_node_id>${via} AND (excluded.relay_role<>'origin' OR computer_peers.relay_role='origin')))`;
              }

              yield* sql`UPDATE computer_peers SET relay_revision=${catalog.revision} WHERE owner_user_id=${store.owner}::uuid AND node_id=${via}`;
            }),
          );
        }),
      );
      await this.#reload();
    });
  }
}
