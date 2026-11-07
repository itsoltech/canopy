import { create, toJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";

import { bots, PermissionMode, Provider, ui } from "@canopy/contracts";

import { AGENT_BUS, REMOTE_BOTS, splitId } from "@canopy/domain/computers";

import { Match, Predicate, Schema } from "effect";

import type { BotTurn, StoredCall } from "../bots/types.ts";

import { BotStore } from "../bots/store.ts";

import { fail, isToolArguments, record, text, type Actor, type Arguments } from "./agents-context.ts";
import type { LinkedAgents } from "./agents.ts";
import { gather } from "../api/routed-overview.ts";
import { PEER_READ_TIMEOUT_MS } from "./timing.ts";
import { requestedThreadPermission } from "../bots/thread-permission.ts";
import { SettingsStore } from "../store/settings.ts";

export interface AgentsBotToolsMethods {
  botTool(
    turn: BotTurn,
    call: StoredCall,
  ): Promise<
    | string
    | number
    | boolean
    | JsonObject
    | JsonValue[]
    | { machine: string }[]
    | { id: string; name: string | undefined; machine: string | undefined }[]
    | {
        turns: { id: string; status: string }[];
        interactions: { request: any }[];
        messages: { role: string; text: string }[];
      }
    | null
    | undefined
  >;
}

export const agentsBotToolsMethods: AgentsBotToolsMethods = {
  async botTool(this: LinkedAgents, turn: BotTurn, call: StoredCall) {
    if (!isToolArguments(call.arguments)) return fail("Invalid linked agent arguments");
    const args = call.arguments;
    this.redirect(args);

    if (call.tool.name === "list_threads") {
      return await listBotThreads(this, args);
    }

    if (call.tool.name === "list_bots") {
      return await listLinkedBots(this);
    }

    const ref = ["workspace_id", "thread_id", "bot_id", "worker_id", "request_id"]
      .map((key) => args[key])
      .find((v) => Predicate.isString(v) && splitId(v).node);

    if (!Predicate.isString(ref)) return undefined;
    const node = await this.peer(ref);
    await this.sameHome(node, args);
    const ownBot = await this.core.bots.get(turn.bot_id);

    const actor: Actor = {
      id: turn.bot_id,
      kind: "bot",
      hops: turn.hops + 1,
      name: ownBot.configuration?.name || "Bot",
      ...(turn.routine_id && { routineId: turn.routine_id, routineTitle: turn.routine_title }),
    };

    if (actor.hops > 7) return fail("Agent-to-agent chain limit reached (8 hops without human input)");

    const action = async (run: () => Promise<JsonValue>) => {
      // Remote effects cannot share a local SQL transaction: two bots messaging each
      // other would otherwise hold their own bot locks while waiting for the peer.
      // Fence and mark first, as with MCP. Recovery never repeats an unknown write.
      await this.scope.run(BotStore.use((s) => s.remoteStarted(turn, call, true)));

      return run();
    };

    switch (call.tool.name) {
      case "start_thread":
        if (args["workspace_mode"] && args["workspace_mode"] !== "checkout")
          return fail(
            "Worktrees on linked computers are not supported yet. Open Canopy on the workspace's home computer to use a worktree.",
          );

        return action(async () =>
          this.send(node, "spawn", actor, call.id, {
            request: toJson(ui.CreateThreadRequestSchema, await botDefaultThreadRequest(this, args, call.id, ownBot)),
            instructions: "",
            interactions: "parent",
            notify: true,
          }),
        );
      case "send_message":
        return action(() =>
          this.send(node, "send", actor, call.id, {
            target: splitId(text(args, "thread_id")).id,
            target_kind: "thread",
            prompt: text(args, "text"),
            delivery: args["delivery"] ?? "queue",
            notify: true,
          }),
        );
      case "send_bot_message":
        return action(async () => {
          const target = text(args, "bot_id");

          const result = await this.send(node, "send", actor, call.id, {
            target: splitId(target).id,
            target_kind: "bot",
            prompt: text(args, "text"),
            notify: true,
          });

          if (!turn.routine_id)
            await this.query(
              `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text,exchange_id)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$2,$5,'event',$6,$7::uuid) ON CONFLICT(turn_id,message_key) DO NOTHING`,
              [crypto.randomUUID(), turn.bot_id, turn.id, `linked:${call.id}`, target, text(args, "text"), call.id],
            );
          await this.query("UPDATE bots SET revision=revision+1,updated_at=now() WHERE id=$1::uuid", [turn.bot_id]);

          return { ...record(result), bot_id: target, exchange_id: call.id };
        });
      case "get_thread":
        return toJson(
          ui.ThreadSchema,
          (
            await this.ui(
              "GetThread",
              create(ui.GetThreadRequestSchema, { threadId: text(args, "thread_id") }),
              ui.GetThreadResponseSchema,
            )
          ).thread!,
        );
      case "read_thread":
        return readBotThread(this, args);

      case "list_models":
        return toJson(
          ui.ListModelsResponseSchema,
          await this.ui(
            "ListModels",
            create(ui.ListModelsRequestSchema, { workerId: text(args, "worker_id") }),
            ui.ListModelsResponseSchema,
          ),
        );
      case "answer_interaction":
        return action(async () => {
          // The bot's own home already applied its approval policy before this dispatch.
          let answerJson = "";

          if (args["answers"]) answerJson = JSON.stringify({ answers: args["answers"] });

          return toJson(
            ui.InteractionSchema,
            (
              await this.ui(
                "AnswerInteraction",
                create(ui.AnswerInteractionRequestSchema, {
                  requestId: text(args, "request_id"),
                  allow: args["allow"] === true,
                  allowForSession: args["allow_for_session"] === true,
                  cancelled: args["cancelled"] === true,
                  message: text(args, "message", true),
                  answerJson,
                }),
                ui.AnswerInteractionResponseSchema,
              )
            ).interaction!,
          );
        });
      default:
        return fail("This bot tool is unavailable on a linked computer");
    }
  },
};

function botThreadRequest(args: Arguments, callId: string): ui.CreateThreadRequest {
  return create(ui.CreateThreadRequestSchema, {
    workspaceMode: ui.WorkspaceMode.CHECKOUT,
    projectId: splitId(text(args, "project_id")).id,
    workspaceId: splitId(text(args, "workspace_id")).id,
    provider: Match.value(args["provider"]).pipe(
      Match.when("claude", () => Provider.CLAUDE),
      Match.when("grok", () => Provider.GROK),
      Match.orElse(() => Provider.CODEX),
    ),
    providerProfileId: text(args, "provider_instance"),
    model: text(args, "model", true),
    effort: text(args, "effort", true),
    title: text(args, "title", true),
    initialMessage: text(args, "prompt"),
    clientRequestId: callId,
    permissionMode:
      {
        read_only: PermissionMode.READ_ONLY,
        ask: PermissionMode.ASK,
        accept_edits: PermissionMode.ACCEPT_EDITS,
        full_auto: PermissionMode.FULL_AUTO,
      }[String(args["permission"] ?? "ask")] ?? PermissionMode.ASK,
  });
}

async function botDefaultThreadRequest(host: LinkedAgents, args: Arguments, callId: string, bot: bots.Bot) {
  const request = botThreadRequest(args, callId);

  const defaults = await host.scope.run(SettingsStore.use((s) => s.user(host.owner)));
  request.permissionMode = requestedThreadPermission(
    bot.configuration!,
    text(args, "permission", true),
    defaults.threadDefaults?.permissionMode,
  );

  return request;
}

async function readBotThread(hostContext: LinkedAgents, args: Arguments) {
  const snapshot = await hostContext.snapshot(text(args, "thread_id"));

  return {
    turns: snapshot.turns.map((t) => ({ id: t.id, status: t.status })),
    interactions: snapshot.interactions.map((i) => ({
      ...record(toJson(ui.InteractionSchema, i)),
      request: JSON.parse(i.requestJson),
    })),
    messages: snapshot.items
      .flatMap((i) =>
        i.item?.content.case === "agentMessage" || i.item?.content.case === "userMessage"
          ? [{ role: i.item.content.case === "agentMessage" ? "assistant" : "user", text: i.item.content.value.text }]
          : [],
      )
      .slice(-100),
  };
}

async function listBotThreads(hostContext: LinkedAgents, args: Arguments): Promise<JsonValue> {
  const project = Predicate.isString(args["project_id"]) ? args["project_id"] : "";

  const request = create(ui.ListThreadsRequestSchema, {
    projectId: project,
    includeArchived: args["include_archived"] === true,
  });

  let threads = splitId(project).node
    ? (await hostContext.ui("ListThreads", request, ui.ListThreadsResponseSchema)).threads
    : await hostContext.core.listThreads(project, request.includeArchived);

  if (!project) {
    const others = await gather<ui.ListThreadsResponse>(
      hostContext.core,
      "ListThreads",
      request,
      AbortSignal.timeout(PEER_READ_TIMEOUT_MS),
    );

    for (const response of others)
      threads.push(
        ...response.threads.filter((thread) =>
          hostContext.core.computers?.capabilities(thread.nodeId).includes(AGENT_BUS),
        ),
      );
  }

  const query = String(args["query"] ?? "").toLowerCase();

  const statuses =
    args["statuses"] === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.Array(Schema.String))(args["statuses"]);

  threads = threads
    .filter(
      (t) => (!query || t.title.toLowerCase().includes(query)) && (!statuses?.length || statuses.includes(t.status)),
    )
    .slice(0, Math.min(Number(args["limit"] ?? 100), 500));

  return Promise.all(
    threads.map(async (t) => ({ ...record(toJson(ui.ThreadSchema, t)), machine: await hostContext.machine(t.nodeId) })),
  );
}

async function listLinkedBots(hostContext: LinkedAgents) {
  const own: { id: string; name: string | undefined; machine: string | undefined }[] = (
    await hostContext.core.bots.list()
  ).map((b) => ({
    id: b.id,
    name: b.configuration?.name,
    machine: "This computer",
  }));

  const others = await gather<bots.ListBotsResponse>(
    hostContext.core,
    "ListBots",
    create(bots.ListBotsRequestSchema),
    AbortSignal.timeout(PEER_READ_TIMEOUT_MS),
  );

  for (const response of others)
    for (const bot of response.bots) {
      if (!hostContext.core.computers?.capabilities(bot.nodeId).includes(REMOTE_BOTS)) continue;
      const peer = await hostContext.core.computers.computer(bot.nodeId);
      own.push({ id: bot.id, name: bot.configuration?.name, machine: peer?.displayName || peer?.name });
    }

  return own;
}
