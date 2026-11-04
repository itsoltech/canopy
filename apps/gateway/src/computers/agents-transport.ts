import { clone, create, type DescMessage, type JsonValue, type Message, type MessageShape } from "@bufbuild/protobuf";

import { bots, computerLink as link, ui } from "@canopy/contracts";

import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";

import { Effect, Predicate, Schema } from "effect";

import { SqlClient } from "effect/sql";

import { fail, qualifyResult, type Actor, type Arguments } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";
import { linkedMessage, methodNamed, movedItems, qualify, unqualify } from "./remote.ts";

export async function agentsRemoteSnapshot(hostContext: LinkedAgents, id: string): Promise<ui.ThreadSnapshot> {
  const update = await hostContext.ui(
    "WatchThread",
    create(ui.WatchThreadRequestSchema, { threadId: id }),
    ui.ThreadUpdateSchema,
  );

  return update.change.case === "snapshot" ? update.change.value : fail("Missing thread snapshot");
}

export interface AgentsTransportMethods {
  query<A extends object>(statement: string, parameters?: unknown[]): Promise<readonly A[]>;
  machine(node: string): Promise<string>;
  call(node: string, operation: string, actor: Actor, callId: string, args: Arguments): Promise<JsonValue>;
  redirect(args: Arguments): void;
  peer(ref: string): Promise<string>;
  sameHome(node: string, args: Arguments): void;
  ui<D extends DescMessage>(name: string, request: Message, output: D): Promise<MessageShape<D>>;
  snapshot(id: string): Promise<ui.ThreadSnapshot>;
  thread(id: string): Promise<ui.Thread>;
  exchange(id: string): Promise<bots.BotMessage[]>;
}

export const agentsTransportMethods: AgentsTransportMethods = {
  query<A extends object>(this: LinkedAgents, statement: string, parameters: unknown[] = []): Promise<readonly A[]> {
    return this.scope.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(statement, parameters);
      }),
    );
  },

  async machine(this: LinkedAgents, node: string): Promise<string> {
    const peer = node && (await this.core.computers?.computer(node));

    return peer ? peer.displayName || peer.name : "This computer";
  },

  async call(
    this: LinkedAgents,
    node: string,
    operation: string,
    actor: Actor,
    callId: string,
    args: Arguments,
  ): Promise<JsonValue> {
    const computers = this.core.computers;

    if (!computers) return fail("That computer is no longer linked");

    try {
      for await (const result of computers.remote(
        node,
        link.LinkedAgentsService.method.callAgentBus,
        create(link.LinkedAgentCallSchema, {
          operation,
          callId,
          actorId: actor.id,
          actorKind: actor.kind,
          hops: actor.hops,
          argumentsJson: JSON.stringify({ ...args, sender_name: actor.name }),
        }),
        AbortSignal.timeout(10_000),
      ))
        return qualifyResult(
          Schema.decodeUnknownSync(Schema.MutableJson)(
            JSON.parse(linkedMessage(link.LinkedAgentResultSchema, result).resultJson),
          ),
          node,
        );
    } catch (error) {
      // The target moved (stage 8): learn its new home and deliver there once, when it is a partner of this computer.
      const moved = movedItems(error);
      const home = moved?.[0]?.homeNodeId;

      if (
        !moved ||
        !home ||
        home === node ||
        !(await computers.redirects.learn(node, moved), await computers.store.peer(home))
      )
        throw error;

      if (operation === "send")
        await this.query(
          "UPDATE computer_agent_calls SET peer_node_id=$3 WHERE owner_user_id=$1::uuid AND peer_node_id=$2 AND call_id=$4::uuid AND direction='outgoing'",
          [this.owner, node, home, callId],
        );

      return this.call(home, operation, actor, callId, args);
    }

    return fail("The other computer sent no answer");
  },

  /** Old ids of moved threads and bots in a tool's arguments name their new home (stage 8). */
  redirect(this: LinkedAgents, args: Arguments): void {
    const redirects = this.core.computers?.redirects;

    if (!redirects?.size) return;

    for (const key of ["thread_id", "bot_id"]) if (Predicate.isString(args[key])) args[key] = redirects.map(args[key]);

    if (Array.isArray(args["thread_ids"]))
      args["thread_ids"] = args["thread_ids"].map((v) => (Predicate.isString(v) ? redirects.map(v) : v));
  },

  async peer(this: LinkedAgents, ref: string): Promise<string> {
    const node = splitId(ref).node;

    if (!node || !this.core.computers) return fail("Choose a target on a linked computer");

    return (await this.core.computers.resolve(node)).node_id;
  },

  sameHome(this: LinkedAgents, node: string, args: Arguments): void {
    for (const key of ["workspace_id", "project_id", "thread_id", "bot_id", "worker_id", "request_id"]) {
      const value = args[key];

      if (!Predicate.isString(value) || !value) continue;

      if (key === "project_id" && this.core.computers?.shared?.projects.has(value)) continue;

      if (splitId(value).node !== nodeRef(node)) return fail("Choose targets on the same linked computer");
    }
  },

  async ui<D extends DescMessage>(
    this: LinkedAgents,
    name: string,
    request: Message,
    output: D,
  ): Promise<MessageShape<D>> {
    const method = methodNamed(name)!;

    const node = await this.peer(
      String(Object.values(request).find((v) => Predicate.isString(v) && splitId(v).node) ?? ""),
    );

    const outbound = clone(method.input, request);
    unqualify(method.input, outbound, node, this.core.computers?.shared?.projects);

    for await (const result of this.core.computers!.remote(node, method, outbound, AbortSignal.timeout(10_000))) {
      qualify(output, result, node);

      return linkedMessage(output, result);
    }

    return fail("The other computer sent no answer");
  },

  async snapshot(this: LinkedAgents, id: string): Promise<ui.ThreadSnapshot> {
    if (!splitId(id).node) {
      const abort = new AbortController();

      try {
        for await (const update of this.core.watchThread(id, abort.signal))
          if (update.change.case === "snapshot") return update.change.value;
      } finally {
        abort.abort();
      }

      return fail("Missing thread snapshot");
    }

    return agentsRemoteSnapshot(this, id);
  },

  async thread(this: LinkedAgents, id: string): Promise<ui.Thread> {
    return splitId(id).node
      ? (await this.ui("GetThread", create(ui.GetThreadRequestSchema, { threadId: id }), ui.GetThreadResponseSchema))
          .thread!
      : this.core.getThread(id);
  },

  async exchange(this: LinkedAgents, id: string): Promise<bots.BotMessage[]> {
    const ref = splitId(id);
    let node = ref.node ? await this.peer(id) : "";

    if (!node)
      node =
        (
          await this.query<{ peer_node_id: string }>(
            "SELECT peer_node_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid AND call_id=$2::uuid AND direction='outgoing' AND actor_kind='bot' AND target_kind='bot' AND NOT detached",
            [this.owner, id],
          )
        )[0]?.peer_node_id ?? "";

    if (!node) return this.core.bots.exchange(id);

    if (!this.core.computers!.reachable().includes(node))
      return (await this.core.computers!.botMirror.conversations(node)).flatMap((c) =>
        c.messages.filter((m) => m.exchangeId === qualifyId(ref.id, node)),
      );

    return (
      await this.ui(
        "ReadBotExchange",
        create(bots.ReadBotExchangeRequestSchema, { exchangeId: qualifyId(ref.id, node) }),
        bots.ReadBotExchangeResponseSchema,
      )
    ).messages;
  },
};
