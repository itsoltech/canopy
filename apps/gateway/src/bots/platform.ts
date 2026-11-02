import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";
import { Effect } from "effect";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import { GatewayStore, Invalid, NotFound } from "../store/store.ts";
import { BotStore, requiredString } from "./store.ts";
import { statusPhrase } from "./policy.ts";
import type { BotTurn, StoredCall, ToolSpec } from "./types.ts";

/** Resolve display labels through the same owner-scoped paths as the action. */
export async function describeBotTool(core: GatewayCore, tool: ToolSpec, args: Record<string, unknown>): Promise<string> {
  if (tool.source !== "platform") return statusPhrase(tool, args);
  try {
    if (tool.name === "start_thread" && typeof args["project_id"] === "string") {
      const project = (await core.overview()).projects.find((p) => p.id === args["project_id"]);
      return statusPhrase(tool, { ...args, project_name: project?.name });
    }
    if (typeof args["thread_id"] === "string") return statusPhrase(tool, { ...args, thread_name: (await core.getThread(args["thread_id"])).title });
    if (tool.name === "send_bot_message" && typeof args["bot_id"] === "string") return statusPhrase(tool, { ...args, bot_name: (await core.bots.get(args["bot_id"])).configuration?.name });
  } catch { /* A missing label must not bypass validation of the actual action. */ }
  return statusPhrase(tool);
}

export async function botPlatform(core: GatewayCore, options: GatewayCoreOptions, turn: BotTurn, call: StoredCall): Promise<unknown> {
  const args = call.arguments;
  const string = (key: string, max?: number) => requiredString(args, key, max);
  const optional = (key: string) => typeof args[key] === "string" ? args[key] as string : "";
  const user = options.userId;
  const readThread = (id: string) => GatewayStore.use((s) => Effect.gen(function* () {
    const row = yield* s.thread(id);
    if (row.owner_user_id !== user) return yield* Effect.fail(new NotFound("thread not found"));
    return row;
  }));
  const action = <A, E>(effect: Effect.Effect<A, E, GatewayStore | BotStore>) => options.runtime.runPromise(BotStore.use((s) => s.action(turn, call, effect)));
  try {
    switch (call.tool.name) {
      case "list_projects": return (await core.overview()).projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, workspaces: p.workspaces.map((w) => ({ id: w.id, worker_id: w.workerId, label: w.label })) }));
      case "list_workers": return (await core.overview()).workers.map((w) => ({ id: w.id, name: w.name, online: w.online }));
      case "list_provider_instances": return (await core.listProviderInstances()).map((i) => ({ id: i.id, label: i.label, provider: Provider[i.harness], kind: i.kind }));
      case "list_bots": return (await core.bots.list()).map((b) => ({ id: b.id, name: b.configuration?.name }));
      case "list_threads": return (await core.listThreads(string("project_id"))).map((t) => ({ id: t.id, title: t.title, status: t.status }));
      case "get_thread": { const t = await core.getThread(string("thread_id")); return { id: t.id, title: t.title, status: t.status }; }
      case "read_thread": return options.runtime.runPromise(Effect.gen(function* () {
        const row = yield* readThread(string("thread_id"));
        const snapshot = yield* GatewayStore.use((s) => s.snapshot(row.id));
        return snapshot.items.flatMap((i) => {
          const c = i.item?.content;
          return c?.case === "agentMessage" || c?.case === "userMessage" ? [{ role: c.case === "agentMessage" ? "assistant" : "user", text: c.value.text }] : [];
        }).slice(-100);
      }));
      case "start_thread": {
        const permissions: Record<string, PermissionMode> = { ask: PermissionMode.ASK, read_only: PermissionMode.READ_ONLY, accept_edits: PermissionMode.ACCEPT_EDITS, full_auto: PermissionMode.FULL_AUTO };
        const permission = permissions[optional("permission") || "ask"];
        if (!permission || !["claude", "codex"].includes(string("provider"))) throw new Invalid("unknown provider or permission");
        return await core.startBotThread(turn, call, create(ui.CreateThreadRequestSchema, {
          projectId: string("project_id"), workspaceId: string("workspace_id"), provider: string("provider") === "claude" ? Provider.CLAUDE : Provider.CODEX,
          providerProfileId: string("provider_instance"), model: string("model", 200), effort: optional("effort"), permissionMode: permission,
          initialMessage: string("prompt"), title: optional("title"), clientRequestId: call.id,
        }));
      }
      case "send_message": {
        return await core.sendBotThreadMessage(turn, call, string("thread_id"), string("text"), optional("delivery") || "queue");
      }
      case "send_bot_message": return action(BotStore.use((s) => s.sendToBot(user, turn, call)));
      case "schedule_wakeup": return action(BotStore.use((s) => s.wakeup(turn, call)));
      case "list_schedules": return core.bots.run((s) => s.wakeups(turn.bot_id));
      case "cancel_schedule": return action(BotStore.use((s) => s.cancelWakeup(turn.bot_id, string("schedule_id"))));
      case "rename_thread": return await core.updateBotThread(turn, call, create(ui.UpdateThreadRequestSchema, { threadId: string("thread_id"), title: string("title", 200) }));
      case "set_thread_model": return await core.updateBotThread(turn, call, create(ui.UpdateThreadRequestSchema, { threadId: string("thread_id"), model: string("model", 200), effort: optional("effort") }));
      case "archive_thread": return await core.archiveBotThread(turn, call, string("thread_id"));
      default: return { error: "Unknown platform tool" };
    }
  } catch (error) {
    // Never echo SQL/transport diagnostics, credentials or internal URLs to the model or UI.
    return { error: error instanceof Invalid ? error.message : "Platform action rejected or unavailable" };
  }
}
