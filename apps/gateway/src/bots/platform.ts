import { isHarness, providerOf } from "@canopy/domain/harnesses";
import { interactionView } from "./tools/threads.ts";
import { wantsThreadPage } from "./tools/read-thread-page.ts";
import { authorizeBotThreadCall } from "../core/bot-thread-audience.ts";
import { isMemoryTool } from "@canopy/domain/memory-tools";
import { botMemoryCall } from "./memory.ts";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { isEntityId, nodeRef, splitId } from "@canopy/domain/computers";
import { Effect, Predicate } from "effect";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import { GatewayStore, Invalid, NotFound } from "../store/store.ts";
import { platformError } from "./errors.ts";
import { BotStore } from "./store.ts";
import { approvalPrompt, nextReplyHop, statusPhrase } from "./policy.ts";
import { threadSharingNotice } from "./approval-fields.ts";
import { forwardingApproval, forwardingIds, localForwardTarget } from "../core/bot-files.ts";
import type { BotTurn, PreparedBotTool, StoredCall, ToolSpec } from "./types.ts";
import { areaTool } from "./tools/index.ts";
import { context, validate, type ToolResult } from "./tools/shared.ts";
import { automationMode, inheritedWorkspace } from "../worktrees/automation.ts";
import { coreState } from "../core/core-context.ts";
import { botThreadPermission } from "./thread-permission.ts";
import { botThreadConnectionEnabled, BOT_THREADS_DISCONNECTED } from "../store/module-access.ts";
import { threadToolNames, usesThreadConnection } from "./thread-tools.ts";
import { SettingsStore } from "../store/settings.ts";

/** Legacy tools: an unknown provider name keeps meaning Codex, as before. */
const legacyProvider = (name: string) => providerOf(name) || Provider.CODEX;

/** Resolve display labels through the same owner-scoped paths as the action. */
export async function describeBotTool(core: GatewayCore, tool: ToolSpec, args: JsonObject): Promise<string> {
  if (tool.source !== "platform") return statusPhrase(tool, args);
  const fields = tool.parameters["properties"];
  args = Object.fromEntries(
    Object.entries(localBotMessageArgs(core, tool.name, args)).filter(
      ([key]) => !key.endsWith("_name") && Predicate.isObject(fields) && Object.hasOwn(fields, key),
    ),
  );
  const options = core[coreState].options;

  if (
    (usesThreadConnection(tool.name) || args["thread_id"] || args["project_id"]) &&
    !(await options.runtime.runPromise(botThreadConnectionEnabled(options.userId)))
  )
    return statusPhrase(tool);
  const ref = Object.values(args).find((v) => Predicate.isString(v) && splitId(v).node);
  const node = Predicate.isString(ref) ? await core.linkedAgents.peer(ref).catch(() => "") : "";
  const machine = node ? ` on ${await core.linkedAgents.machine(node)}` : "";
  const phrase = (value: JsonObject) => statusPhrase(tool, value) + machine;

  try {
    const projectId = args["project_id"];
    const workerId = args["worker_id"];
    const threadId = args["thread_id"];
    const botId = args["bot_id"];

    const overview =
      Predicate.isString(projectId) || Predicate.isString(workerId)
        ? await core.linkedAgents.overview(Predicate.isString(projectId) ? "bot-thread" : undefined)
        : undefined;

    const projectName = overview?.projects.find((p) => p.id === projectId)?.name;
    const workerName = overview?.workers.find((w) => w.id === workerId)?.name;

    args = {
      ...args,
      ...(Predicate.isString(projectId) && { project_name: projectName ?? `a project (${projectId})` }),
      ...(Predicate.isString(workerId) && { worker_name: workerName ?? `a worker (${workerId})` }),
    };

    if (tool.name === "start_thread" && Predicate.isString(projectId)) {
      return phrase(args);
    }

    if (Predicate.isString(threadId))
      return phrase({ ...args, thread_name: (await core.linkedAgents.thread(threadId, "bot-thread")).title });

    if (tool.name === "send_bot_message" && Predicate.isString(botId)) {
      const bot = splitId(botId).node
        ? (await core.linkedAgents.ui("GetBot", create(bots.GetBotRequestSchema, { botId }), bots.GetBotResponseSchema))
            .bot
        : await core.bots.get(botId);

      const botName = bot?.configuration?.name;

      return phrase({ ...args, bot_name: botName ?? `a bot (${botId})` });
    }
  } catch {
    /* A missing label must not bypass validation of the actual action. */
  }

  return phrase({
    ...args,
    ...(Predicate.isString(args["project_id"]) && {
      project_name: args["project_name"] ?? `a project (${args["project_id"]})`,
    }),
    ...(Predicate.isString(args["bot_id"]) && { bot_name: `a bot (${args["bot_id"]})` }),
  });
}

/** A tool's own pre-approval check (see PlatformTool.prepare); throws errors the model can act on. */
export async function prepareBotTool(
  core: GatewayCore,
  options: GatewayCoreOptions,
  turn: BotTurn,
  call: StoredCall,
): Promise<PreparedBotTool | undefined> {
  if (call.tool.source !== "platform") return undefined;
  call = await availableBotCall(options, {
    ...call,
    arguments: localBotMessageArgs(core, call.tool.name, call.arguments),
  });

  if (["start_thread", "send_message", "send_bot_message"].includes(call.tool.name)) nextReplyHop(turn.hops);

  if (["start_thread", "send_message"].includes(call.tool.name)) {
    validate(call.tool.parameters, call.arguments);
    const ids = forwardingIds(call.arguments);
    localForwardTarget(call.arguments, ids);
    const access = await authorizeBotThreadCall(core, turn, call, "prepare");
    const thread = access?.restrictedThread;
    const title = thread?.title.replace(/\s+/g, " ").trim();

    const prompt = thread
      ? [
          title ? `Needs approval · Messaging “${title}”` : "Needs approval · Messaging a thread",
          `Sharing: ${threadSharingNotice}`,
          `Thread ID: ${thread.id}`,
          `Delivery: ${call.arguments["delivery"] === "steer" ? "Send to active turn" : "Queue"}`,
          `Message: ${context(core, options, turn, call).string("text")}`,
        ].join("\n")
      : approvalPrompt(call.tool, call.arguments, await describeBotTool(core, call.tool, call.arguments));

    const forwarding = await forwardingApproval(core, turn, ids, prompt);

    return thread ? { prompt: forwarding?.prompt ?? prompt, restrictedThreadId: thread.id } : forwarding;
  }

  await authorizeBotThreadCall(core, turn, call);
  const registered = areaTool.get(call.tool.name);

  if (!registered?.prepare) return undefined;
  validate(registered.spec.parameters, call.arguments);

  return registered.prepare(context(core, options, turn, call));
}

/** A reference copied from a peer can still name a thread on the bot's own home. */
function localBotMessageArgs(core: GatewayCore, name: string, args: JsonObject): JsonObject {
  const computers = core.computers;
  const target = args["thread_id"];

  if (!computers || name !== "send_message" || !Predicate.isString(target) || !isEntityId(target)) return args;
  const attachments = args["attachment_ids"];

  // Keep the existing forwarding check for qualified targets, including moved threads.
  if (Array.isArray(attachments) && attachments.length) return args;

  const { id, node } = splitId(target);

  return node === nodeRef(computers.hello().nodeId) ? { ...args, thread_id: id } : args;
}

async function availableBotCall(options: GatewayCoreOptions, call: StoredCall): Promise<StoredCall> {
  const name = call.tool.name;

  if (!usesThreadConnection(name) || (await options.runtime.runPromise(botThreadConnectionEnabled(options.userId))))
    return call;

  if (threadToolNames.has(name) || call.arguments["scope"] === "platform") throw new Invalid(BOT_THREADS_DISCONNECTED);

  // A disconnected bot can list and cancel its own reminders through the shared schedule tools.
  const { limit, offset } = call.arguments;

  return {
    ...call,
    arguments: {
      scope: "wakeup",
      ...(name === "cancel_schedule" && { schedule_id: call.arguments["schedule_id"]! }),
      ...(name === "list_schedules" && limit !== undefined && { limit }),
      ...(name === "list_schedules" && offset !== undefined && { offset }),
    },
  };
}

export async function botPlatform(
  core: GatewayCore,
  options: GatewayCoreOptions,
  turn: BotTurn,
  call: StoredCall,
): Promise<ToolResult> {
  const args = localBotMessageArgs(core, call.tool.name, call.arguments);
  call = { ...call, arguments: args };
  const { string, optional } = context(core, options, turn, call);
  const user = options.userId;

  const action = <A, E>(effect: Effect.Effect<A, E, GatewayStore | BotStore>) =>
    options.runtime.runPromise(BotStore.use((s) => s.action(turn, call, effect)));

  try {
    call = await availableBotCall(options, call);
    validate(call.tool.parameters, args);

    if (["start_thread", "send_message"].includes(call.tool.name)) localForwardTarget(args, forwardingIds(args));
    const questionId = (await authorizeBotThreadCall(core, turn, call))?.questionId;

    if (questionId && call.tool.name === "read_thread") {
      const questions = await core[coreState].actions.run(
        GatewayStore.use((store) => store.pendingInteractions(string("thread_id"), [questionId])),
      );

      return {
        interactions: questions.map(interactionView),
        turns: [],
        messages: [],
        ...(wantsThreadPage(args) && { page: { next_before: null } }),
      };
    }

    if (isMemoryTool(call.tool.name)) return await botMemoryCall(context(core, options, turn, call));

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
      case "list_models":
        return await listBotModels(core, turn, { string, optional });

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

      case "start_thread":
        return await startThread(core, turn, call, { string, optional });

      case "send_message":
        return await core.sendBotThreadMessage(
          turn,
          call,
          string("thread_id"),
          string("text"),
          optional("delivery") || "queue",
        );
      case "send_bot_message":
        return await action(BotStore.use((s) => s.sendToBot(user, turn, call)));
      case "schedule_wakeup":
        return action(BotStore.use((s) => s.wakeup(turn, call)));
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

type Args = Pick<ReturnType<typeof context>, "string" | "optional">;

/** list_models defaults to the bot's worker and instance, preserving native harness aliases. */
async function listBotModels(core: GatewayCore, turn: BotTurn, { string, optional }: Args) {
  const requested = optional("provider");

  if (requested && !isHarness(requested)) throw new Invalid("unknown provider");

  if (!optional("worker_id")) {
    const config = (await core.bots.get(turn.bot_id)).configuration!;

    return await core.bots.run((s) =>
      s.harnessModels(
        core[coreState].options.userId,
        requested ? legacyProvider(requested) : config.provider,
        optional("provider_instance") || config.providerInstance,
        config.workerId,
      ),
    );
  }

  if (!(await core.overview()).workers.some((w) => w.id === string("worker_id")))
    throw new NotFound("worker not found");

  const provider = legacyProvider(string("provider"));

  return (await botModels(core, string("worker_id"), provider, string("provider_instance"))).map((m) => ({
    id: m.id,
    name: m.displayName || m.id,
    default: m.isDefault,
    efforts: m.efforts,
    default_effort: m.defaultEffort,
  }));
}

/** start_thread: a thread the bot starts in a workspace, with the instance's default model when none is given. */
async function startThread(core: GatewayCore, turn: BotTurn, call: StoredCall, { string, optional }: Args) {
  const owner = core[coreState].options.userId;
  const config = (await core.bots.get(turn.bot_id)).configuration!;
  const defaults = await core[coreState].options.runtime.runPromise(SettingsStore.use((s) => s.user(owner)));

  const permission = botThreadPermission(config, defaults.threadDefaults?.permissionMode);

  if (!permission || !isHarness(string("provider"))) throw new Invalid("unknown provider or permission");

  const provider = legacyProvider(string("provider"));

  // Without a model: the instance's default on the workspace's worker (bots must not guess model names).
  let model = optional("model");

  if (!model) {
    const workerId = (await core.overview()).projects
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === string("workspace_id"))?.workerId;

    if (!workerId) throw new Invalid("workspace not found; use list_projects");
    const models = await botModels(core, workerId, provider, string("provider_instance"));
    model = (models.find((m) => m.isDefault) ?? models[0])?.id ?? "";

    if (!model && provider !== Provider.ANTIGRAVITY)
      throw new Invalid("this provider instance reports no models on that worker; use list_models or another instance");
  }

  return await core.startBotThread(
    turn,
    call,
    await inheritedWorkspace(
      core,
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
        workspaceMode: automationMode(optional("workspace_mode")),
        baseRef: optional("base_ref"),
      }),
      core[coreState].options.userId,
      optional("parent_thread_id"),
    ),
  );
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
