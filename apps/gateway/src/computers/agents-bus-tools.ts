import { create, toJson, type JsonValue } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { PermissionMode, Provider, ui, type AgentToolCall } from "@canopy/contracts";

import { agentBusToolsFor, authorizeBusCall, DEFAULT_BUS_LIMITS, type AgentBusCall } from "@canopy/domain";

import { AGENT_BUS, qualifyId, splitId } from "@canopy/domain/computers";

import { Match, Predicate, Schema } from "effect";

import { AgentBusStore, type ThreadRow } from "../store/index.ts";

import { fail, record, text, type Actor, type Arguments, type Reference } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";
import { linkedMessage, methodNamed, qualify } from "./remote.ts";
import { refuseRemoteAutomation } from "../worktrees/remote.ts";

export interface AgentsBusToolsMethods {
  extend(call: AgentBusCall, caller: ThreadRow, result: JsonValue): Promise<JsonValue>;
  tool(request: AgentToolCall, call: AgentBusCall, caller: ThreadRow): Promise<JsonValue | undefined>;
  send(node: string, operation: string, actor: Actor, callId: string, args: Arguments): Promise<JsonValue>;
}

export const agentsBusToolsMethods: AgentsBusToolsMethods = {
  async extend(this: LinkedAgents, call: AgentBusCall, caller: ThreadRow, result: JsonValue): Promise<JsonValue> {
    if (call.tool === "list_agents") return { ...record(result), linked_computers: await this.catalog() };

    if (call.tool !== "list_threads" || !this.core.computers) return result;
    const list = record(result);
    const threads = list["threads"];

    if (!Array.isArray(threads)) return fail("Invalid linked thread list");

    if (call.args.scope === "all") {
      for (const node of this.core.computers.reachable()) {
        if (!this.core.computers.capabilities(node).includes(AGENT_BUS)) continue;

        try {
          for await (const response of this.core.computers.remote(
            node,
            methodNamed("ListThreads")!,
            create(ui.ListThreadsRequestSchema),
            AbortSignal.timeout(3000),
          )) {
            qualify(ui.ListThreadsResponseSchema, response, node);
            const machine = await this.core.computers.computer(node);

            for (const t of linkedMessage(ui.ListThreadsResponseSchema, response).threads)
              if (!call.args.query || t.title.toLowerCase().includes(call.args.query.toLowerCase()))
                threads.push({
                  thread_id: t.id,
                  title: t.title,
                  status: t.status,
                  machine: machine?.displayName || machine?.name || "Linked computer",
                });
          }
        } catch {
          /* disconnected while gathering */
        }
      }
    } else {
      const refs = await this.query<Reference>(
        "SELECT * FROM computer_agent_calls WHERE owner_user_id=$1::uuid AND direction='outgoing' AND actor_id=$2::uuid AND parent_link AND NOT detached",
        [this.owner, caller.id],
      );

      for (const r of refs)
        threads.push({ thread_id: qualifyId(r.target_id, r.peer_node_id), parent_thread_id: caller.id, remote: true });
    }

    return Schema.decodeUnknownSync(Schema.MutableJson)(list);
  },

  async tool(
    this: LinkedAgents,
    request: AgentToolCall,
    call: AgentBusCall,
    caller: ThreadRow,
  ): Promise<JsonValue | undefined> {
    this.redirect(call.args);

    if (call.tool === "wait_threads" && call.args.thread_ids.some((id) => splitId(id).node)) {
      return await waitLinkedThreads(this, request, call, caller);
    }

    const args: Arguments = call.args;

    const ref = Predicate.isString(args["workspace_id"])
      ? args["workspace_id"]
      : Predicate.isString(args["thread_id"])
        ? args["thread_id"]
        : Predicate.isString(args["request_id"])
          ? args["request_id"]
          : "";

    if (!splitId(ref).node) return undefined;

    if (caller.owner_user_id !== this.owner) return fail("Thread not found");

    if (!agentBusToolsFor(caller.remote_parent_ref ? 1 : caller.depth).includes(call.tool))
      return fail("Side threads cannot control or spawn other threads");

    const { facts } = await this.scope.run(
      AgentBusStore.use((s) =>
        s.facts({
          source: {
            callId: request.callId,
            threadId: request.threadId,
            turnId: request.turnId,
            itemId: request.itemId,
          },
          targetIds: [],
        }),
      ),
    );

    if (facts.caller.archived) return fail("This thread is archived");
    const actor: Actor = { id: caller.id, kind: "thread", hops: facts.callerHops + 1, name: caller.title };

    if (actor.hops > 7) return fail("Agent-to-agent chain limit reached (8 hops without human input)");
    const node = await this.peer(ref);
    this.sameHome(node, args);

    if (call.tool === "spawn_thread") {
      refuseRemoteAutomation(call.args.workspace_mode, call.args.fork);

      if (!this.core.computers!.reachable().includes(node)) throw await this.core.computers!.unavailable(node);

      if (!this.core.computers!.capabilities(node).includes(AGENT_BUS))
        return fail(`${await this.machine(node)} needs an update for linked bots and agents`);
      const decision = authorizeBusCall(call, facts);

      if (!decision.allowed) return fail(decision.reason);

      const refs = await this.query<Reference>(
        "SELECT * FROM computer_agent_calls WHERE owner_user_id=$1::uuid AND direction='outgoing' AND actor_id=$2::uuid AND target_id IS NOT NULL AND parent_link AND NOT detached",
        [this.owner, caller.id],
      );

      const active = await Promise.all(
        refs.map(async (r) => {
          try {
            return !(await this.thread(qualifyId(r.target_id, r.peer_node_id))).archivedAt;
          } catch (error) {
            // Missing/deleted children free a slot. An unreachable home is unknown,
            // so conservatively retain its slot until its state can be read again.
            return !(error instanceof ConnectError && error.code === Code.NotFound);
          }
        }),
      );

      if (facts.callerChildren + active.filter(Boolean).length >= DEFAULT_BUS_LIMITS.maxChildrenPerThread)
        return fail("Side thread limit (8) reached; close finished threads first");

      const [provider, instance = "native"] = (
        call.args.provider ?? `${caller.provider}/${caller.provider_profile_id || "native"}`
      ).split(/[/:]/);

      return this.send(node, "spawn", actor, request.callId, {
        request: toJson(
          ui.CreateThreadRequestSchema,
          create(ui.CreateThreadRequestSchema, {
            workspaceId: splitId(call.args.workspace_id!).id,
            projectId: call.args.project_id ? splitId(call.args.project_id).id : "",
            title: call.args.title,
            initialMessage: call.args.prompt,
            provider: Match.value(provider).pipe(
              Match.when("claude", () => Provider.CLAUDE),
              Match.when("grok", () => Provider.GROK),
              Match.orElse(() => Provider.CODEX),
            ),
            providerProfileId: instance,
            model: call.args.model ?? "",
            effort: call.args.effort ?? "",
            clientRequestId: request.callId,
            workspaceMode: ui.WorkspaceMode.CHECKOUT,
            permissionMode: {
              read_only: PermissionMode.READ_ONLY,
              ask: PermissionMode.ASK,
              accept_edits: PermissionMode.ACCEPT_EDITS,
              full_auto: PermissionMode.FULL_AUTO,
            }[call.args.permission_mode ?? facts.callerPermissionMode ?? "ask"],
          }),
        ),
        instructions: call.args.instructions ?? "",
        interactions: call.args.interactions ?? "parent",
        notify: call.args.notify ?? true,
      });
    }

    if (call.tool === "send_message")
      return this.send(node, "send", actor, request.callId, {
        target: splitId(call.args.thread_id).id,
        target_kind: call.args.target_kind ?? "thread",
        prompt: call.args.prompt,
        delivery: call.args.delivery ?? "queue",
        notify: call.args.notify ?? true,
      });

    if (call.tool === "get_thread" || call.tool === "read_thread")
      return this.call(node, call.tool, actor, request.callId, {
        target: splitId(call.args.thread_id).id,
        ...call.args,
        thread_id: splitId(call.args.thread_id).id,
      });

    if (call.tool === "answer_interaction")
      return this.call(node, "answer", actor, request.callId, {
        ...call.args,
        request_id: splitId(call.args.request_id).id,
      });

    if (call.tool === "interrupt_thread" || call.tool === "close_thread")
      return this.call(node, call.tool, actor, request.callId, { target: splitId(call.args.thread_id).id });

    return fail("This agent tool is unavailable across computers");
  },

  async send(
    this: LinkedAgents,
    node: string,
    operation: string,
    actor: Actor,
    callId: string,
    args: Arguments,
  ): Promise<JsonValue> {
    // Persist the route before the remote acceptance so even a fast completion has a recipient.
    const computers = this.core.computers!;

    if (!computers.reachable().includes(node)) throw await computers.unavailable(node);

    if (!computers.capabilities(node).includes(AGENT_BUS))
      return fail(
        `${(await computers.computer(node))?.name || "The other computer"} needs an update for linked bots and agents`,
      );
    await this.scope.transaction(async () => {
      const active = await this.query(
        "SELECT node_id FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2 FOR UPDATE",
        [this.owner, node],
      );

      if (!active.length) return fail("That computer is no longer linked");
      await this.query(
        `INSERT INTO computer_agent_calls(owner_user_id,peer_node_id,call_id,direction,actor_id,actor_kind,operation,hops,parent_link,source_routine_id,source_routine_title,target_id,target_kind)
        VALUES ($1::uuid,$2,$3::uuid,'outgoing',$4::uuid,$5,$6,$7,$8,$9::uuid,$10,$11::uuid,$12) ON CONFLICT DO NOTHING`,
        [
          this.owner,
          node,
          callId,
          actor.id,
          actor.kind,
          operation,
          actor.hops,
          operation === "spawn",
          actor.routineId ?? null,
          actor.routineTitle ?? "",
          operation === "send" ? args["target"] : null,
          operation === "send" ? args["target_kind"] : null,
        ],
      );
    });
    const result = await this.call(node, operation, actor, callId, args);
    const r = record(result);
    await this.query(
      "UPDATE computer_agent_calls SET target_id=$4::uuid,target_kind=$5,result=$6::jsonb WHERE owner_user_id=$1::uuid AND peer_node_id=$2 AND call_id=$3::uuid AND direction='outgoing'",
      [
        this.owner,
        node,
        callId,
        splitId(text(r, "thread_id")).id,
        r["target_kind"] ?? "thread",
        JSON.stringify(result),
      ],
    );

    return result;
  },
};

async function waitLinkedThreads(
  hostContext: LinkedAgents,
  request: AgentToolCall,
  call: Extract<AgentBusCall, { tool: "wait_threads" }>,
  caller: ThreadRow,
): Promise<JsonValue> {
  if (caller.owner_user_id !== hostContext.owner) return fail("Thread not found");
  const localIds = call.args.thread_ids.filter((id) => !splitId(id).node);

  const { facts } = await hostContext.scope.run(
    AgentBusStore.use((s) =>
      s.facts({
        source: {
          callId: request.callId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
        },
        targetIds: localIds,
      }),
    ),
  );

  const decision = authorizeBusCall({ tool: "wait_threads", args: { ...call.args, thread_ids: localIds } }, facts);

  if (!decision.allowed) return fail(decision.reason);
  const actor: Actor = { id: caller.id, kind: "thread", hops: 0, name: caller.title };

  const summaries = async () =>
    Promise.all(
      call.args.thread_ids.map(async (id) => {
        if (!splitId(id).node) return { ...(await hostContext.scope.run(AgentBusStore.use((s) => s.summary(id)))) };
        const node = await hostContext.peer(id);

        const owned = await hostContext.query(
          "SELECT call_id FROM computer_agent_calls WHERE owner_user_id=$1::uuid AND peer_node_id=$2 AND actor_id=$3::uuid AND target_id=$4::uuid AND parent_link AND direction='outgoing' AND NOT detached",
          [hostContext.owner, node, caller.id, splitId(id).id],
        );

        if (!owned.length) return fail("Thread not found in your thread tree");

        return hostContext.call(node, "get_thread", actor, request.callId, { target: splitId(id).id });
      }),
    );

  const deadline = Date.now() + (call.args.timeout_seconds ?? 120) * 1000;

  for (;;) {
    const threads = await summaries();
    const ready = threads.map((t) => record(t)["settled"] === true || Number(record(t)["waiting_for_parent"]) > 0);
    const done = call.args.until === "all" ? ready.every(Boolean) : ready.some(Boolean);

    if (done || Date.now() >= deadline) return { done, threads };
    await Bun.sleep(250);
  }
}
