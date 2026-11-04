import { create } from "@bufbuild/protobuf";
import { bots, PermissionMode, Provider, ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { Effect } from "effect";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import { GatewayStore, Invalid, NotFound } from "../store/store.ts";
import { platformError } from "./errors.ts";
import { BotStore, requiredString } from "./store.ts";
import { statusPhrase } from "./policy.ts";
import type { BotTurn, StoredCall, ToolSpec } from "./types.ts";
import { areaTool } from "./tools/index.ts";
import { context, validate } from "./tools/shared.ts";

/** Resolve display labels through the same owner-scoped paths as the action. */
export async function describeBotTool(
  core: GatewayCore,
  tool: ToolSpec,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.source !== "platform") return statusPhrase(tool, args);
  const ref = Object.values(args).find((v) => typeof v === "string" && splitId(v).node);
  const node = typeof ref === "string" ? await core.linkedAgents.peer(ref).catch(() => "") : "";
  const machine = node ? ` on ${await core.linkedAgents.machine(node)}` : "";
  const phrase = (value: Record<string, unknown>) => statusPhrase(tool, value) + machine;

  try {
    const overview =
      typeof args["project_id"] === "string" || typeof args["worker_id"] === "string"
        ? await core.linkedAgents.overview()
        : undefined;

    args = {
      ...args,
      project_name: overview?.projects.find((p) => p.id === args["project_id"])?.name,
      worker_name: overview?.workers.find((w) => w.id === args["worker_id"])?.name,
    };

    if (tool.name === "start_thread" && typeof args["project_id"] === "string") {
      return phrase(args);
    }

    if (typeof args["thread_id"] === "string")
      return phrase({ ...args, thread_name: (await core.linkedAgents.thread(args["thread_id"])).title });

    if (tool.name === "send_bot_message" && typeof args["bot_id"] === "string") {
      const bot = splitId(args["bot_id"]).node
        ? (
            await core.linkedAgents.ui(
              "GetBot",
              create(bots.GetBotRequestSchema, { botId: args["bot_id"] }),
              bots.GetBotResponseSchema,
            )
          ).bot
        : await core.bots.get(args["bot_id"]);

      return phrase({ ...args, bot_name: bot?.configuration?.name });
    }
  } catch {
    /* A missing label must not bypass validation of the actual action. */
  }

  return phrase(args);
}

/** A tool's own pre-approval check (see PlatformTool.prepare); throws errors the model can act on. */
export async function prepareBotTool(
  core: GatewayCore,
  options: GatewayCoreOptions,
  turn: BotTurn,
  call: StoredCall,
): Promise<{ prompt?: string } | undefined> {
  const registered = call.tool.source === "platform" ? areaTool.get(call.tool.name) : undefined;

  if (!registered?.prepare) return undefined;
  validate(registered.spec.parameters, call.arguments);

  return registered.prepare(context(core, options, turn, call));
}

export async function botPlatform(
  core: GatewayCore,
  options: GatewayCoreOptions,
  turn: BotTurn,
  call: StoredCall,
): Promise<unknown> {
  const args = call.arguments;
  const string = (key: string, max?: number) => requiredString(args, key, max);
  const optional = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const user = options.userId;

  const readThread = (id: string) =>
    GatewayStore.use((s) =>
      Effect.gen(function* () {
        const row = yield* s.thread(id);

        if (row.owner_user_id !== user) return yield* Effect.fail(new NotFound("thread not found"));

        return row;
      }),
    );

  const action = <A, E>(effect: Effect.Effect<A, E, GatewayStore | BotStore>) =>
    options.runtime.runPromise(BotStore.use((s) => s.action(turn, call, effect)));

  try {
    validate(call.tool.parameters, args);
    const linked = await core.linkedAgents.botTool(turn, call);

    if (linked !== undefined) return linked;
    const registered = areaTool.get(call.tool.name);

    if (registered) {
      validate(registered.spec.parameters, args);

      return await registered.execute(context(core, options, turn, call));
    }

    switch (call.tool.name) {
      case "list_projects":
        return (await core.overview()).projects.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          workspaces: p.workspaces.map((w) => ({ id: w.id, worker_id: w.workerId, label: w.label })),
        }));
      case "list_workers":
        return (await core.overview()).workers.map((w) => ({ id: w.id, name: w.name, online: w.online }));
      case "list_provider_instances":
        return (await core.listProviderInstances()).map((i) => ({
          id: i.id,
          label: i.label,
          provider: Provider[i.harness],
          kind: i.kind,
        }));
      case "list_models": {
        const requested = optional("provider");

        if (requested && !["claude", "codex", "grok"].includes(requested)) throw new Invalid("unknown provider");

        if (!optional("worker_id")) {
          const config = (await core.bots.get(turn.bot_id)).configuration!;

          return await core.bots.run((s) =>
            s.apiModels(
              requested
                ? requested === "claude"
                  ? Provider.CLAUDE
                  : requested === "grok"
                    ? Provider.GROK
                    : Provider.CODEX
                : config.provider,
              optional("provider_instance") || config.providerInstance,
            ),
          );
        }

        if (!(await core.overview()).workers.some((w) => w.id === string("worker_id")))
          throw new NotFound("worker not found");

        const provider =
          string("provider") === "claude"
            ? Provider.CLAUDE
            : string("provider") === "grok"
              ? Provider.GROK
              : Provider.CODEX;

        return (await botModels(core, string("worker_id"), provider, string("provider_instance"))).map((m) => ({
          id: m.id,
          name: m.displayName || m.id,
          default: m.isDefault,
          efforts: m.efforts,
          default_effort: m.defaultEffort,
        }));
      }

      case "list_bots":
        return (await core.bots.list()).map((b) => ({ id: b.id, name: b.configuration?.name }));
      case "update_self":
        return await action(BotStore.use((s) => s.updateSelf(user, turn, call)));
      case "list_threads":
        return (await core.listThreads(string("project_id"))).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
        }));
      case "get_thread": {
        const t = await core.getThread(string("thread_id"));

        return { id: t.id, title: t.title, status: t.status };
      }

      case "read_thread":
        return options.runtime.runPromise(
          Effect.gen(function* () {
            const row = yield* readThread(string("thread_id"));
            const snapshot = yield* GatewayStore.use((s) => s.snapshot(row.id));

            return snapshot.items
              .flatMap((i) => {
                const c = i.item?.content;

                return c?.case === "agentMessage" || c?.case === "userMessage"
                  ? [{ role: c.case === "agentMessage" ? "assistant" : "user", text: c.value.text }]
                  : [];
              })
              .slice(-100);
          }),
        );
      case "start_thread": {
        const permissions: Record<string, PermissionMode> = {
          ask: PermissionMode.ASK,
          read_only: PermissionMode.READ_ONLY,
          accept_edits: PermissionMode.ACCEPT_EDITS,
          full_auto: PermissionMode.FULL_AUTO,
        };

        const permission = permissions[optional("permission") || "ask"];

        if (!permission || !["claude", "codex", "grok"].includes(string("provider")))
          throw new Invalid("unknown provider or permission");

        const provider =
          string("provider") === "claude"
            ? Provider.CLAUDE
            : string("provider") === "grok"
              ? Provider.GROK
              : Provider.CODEX;

        // Without a model: the instance's default on the workspace's worker (bots must not guess model names).
        let model = optional("model");

        if (!model) {
          const workerId = (await core.overview()).projects
            .flatMap((p) => p.workspaces)
            .find((w) => w.id === string("workspace_id"))?.workerId;

          if (!workerId) throw new Invalid("workspace not found; use list_projects");
          const models = await botModels(core, workerId, provider, string("provider_instance"));
          model = (models.find((m) => m.isDefault) ?? models[0])?.id ?? "";

          if (!model)
            throw new Invalid(
              "this provider instance reports no models on that worker; use list_models or another instance",
            );
        }

        return await core.startBotThread(
          turn,
          call,
          create(ui.CreateThreadRequestSchema, {
            projectId: string("project_id"),
            workspaceId: string("workspace_id"),
            provider,
            providerProfileId: string("provider_instance"),
            model: model.slice(0, 200),
            effort: optional("effort"),
            permissionMode: permission,
            initialMessage: string("prompt"),
            title: optional("title"),
            clientRequestId: call.id,
          }),
        );
      }

      case "send_message": {
        return await core.sendBotThreadMessage(
          turn,
          call,
          string("thread_id"),
          string("text"),
          optional("delivery") || "queue",
        );
      }

      case "send_bot_message":
        return await action(BotStore.use((s) => s.sendToBot(user, turn, call)));
      case "schedule_wakeup":
        return action(BotStore.use((s) => s.wakeup(turn, call)));
      case "list_schedules":
        return core.bots.run((s) => s.wakeups(turn.bot_id));
      case "cancel_schedule":
        return action(BotStore.use((s) => s.cancelWakeup(turn.bot_id, string("schedule_id"))));
      case "rename_thread":
        return await core.updateBotThread(
          turn,
          call,
          create(ui.UpdateThreadRequestSchema, { threadId: string("thread_id"), title: string("title", 200) }),
        );
      case "set_thread_model":
        return await core.updateBotThread(
          turn,
          call,
          create(ui.UpdateThreadRequestSchema, {
            threadId: string("thread_id"),
            model: string("model", 200),
            effort: optional("effort"),
          }),
        );
      case "archive_thread":
        return await core.archiveBotThread(turn, call, string("thread_id"));
      default:
        return { error: "Unknown platform tool" };
    }
  } catch (error) {
    // Never echo SQL/transport diagnostics, credentials or internal URLs to the model or UI.
    // Validation messages (bad model, offline worker, unknown thread) go back so the bot can correct itself.
    return platformError(error);
  }
}

/** Visible models of one provider instance on a worker, from its last catalog report. */
async function botModels(core: GatewayCore, workerId: string, provider: Provider, instance: string) {
  const catalogs = await core.listModels(create(ui.ListModelsRequestSchema, { workerId }));
  const profile = catalogs.flatMap((c) => c.profiles).find((p) => p.provider === provider && p.profileId === instance);

  if (!profile)
    throw new Invalid(
      `provider instance ${instance} is not available on that worker; use list_provider_instances and list_workers`,
    );

  return profile.models.filter((m) => !m.hidden);
}
