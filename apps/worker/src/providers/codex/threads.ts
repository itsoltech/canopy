import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { ServerNotification, v2 } from "@open-agents/codex-protocol";
import {
  AgentToolCallSchema,
  GoalDirective,
  InteractionKind,
  TurnEndSource,
  TurnOutcome,
  InteractionRequestSchema,
  type AgentToolCall,
  type AgentToolResult,
  type ForkSpec,
  type InteractionRequest,
  type InteractionResponse,
  type Mention,
  type ThreadEvent,
  type ThreadSpec,
  type UserInput,
} from "@open-agents/contracts";
import { agentBusToolSpecs, agentBusToolsFor, viewImageSpec } from "@open-agents/domain";
import type { ViewImageResult } from "../../images/index.ts";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import { pickDefaultEffort } from "../default-effort.ts";
import { codexModel, codexProxyModels, proxyModels, type ModelInit } from "../models.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import { toolCallId } from "../tool-call-id.ts";
import { CodexAppServer, type ServerRequestHandler } from "./app-server.ts";
import { codexThreadProvider, type CodexAppServerLaunch } from "./launch.ts";
import { codexUserInput } from "./input.ts";
import { CodexEventMapper } from "./mapping.ts";
import type { MentionEntryInit } from "../../mentions/catalog.ts";
import { codexAppEntries, codexPluginEntries, codexSkillEntries } from "./catalog.ts";
import { codexPermissions, codexTurnPermissions } from "./permissions.ts";
import { RolloutTail } from "./rollout.ts";
import { RpcError } from "./rpc.ts";
import { reconcileTurn } from "../reconcile.ts";

/**
 * Platform threads on Codex (docs/codex-adapter.md): commands -> app-server requests,
 * notifications -> mapper -> journal (first) -> publish. One registry entry per loaded thread.
 *
 * Every turn notes its rollout in the journal (turn_harness). When the app-server process exits on its own, the
 * turns it ran are settled from their rollouts (providers/reconcile.ts; the end Codex recorded, else failed in the
 * harness: "harness process exited") and the runtime reports failure() so the host starts a new app-server for the
 * next command (docs/durability.md, "Rekoncyliacja z transkryptu harnessu").
 */

export class CodexThreadError extends Schema.TaggedError<CodexThreadError>()("CodexThreadError", {
  threadId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  /** Codex itself refused or failed the request (an app-server error), not the worker. */
  harness: Schema.optional(Schema.Boolean),
}) {}

export type InteractionInit = Omit<MessageInitShape<typeof InteractionRequestSchema>, "threadId" | "requestId">;

export interface CodexThreadsOptions {
  readonly launch: CodexAppServerLaunch;
  readonly clientVersion: string;
  /** Resolved provider profile by id ("" = native). */
  profile(id: string): ResolvedProfile | undefined;
  /** Called after an event is safely in the journal (e.g. send it to the gateway when connected). */
  publish(event: ThreadEvent): void;
  /** Asks the platform (gateway -> user or parent agent) and waits for the answer. */
  interact(request: InteractionRequest): Promise<InteractionResponse>;
  /** Runs an agent bus tool call on the gateway (docs/agent-bus.md) and waits for its result. */
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
  /** The device owner's default reasoning effort (their config.toml, default-effort.ts); read on every use. */
  configuredEffort?(): string | undefined;
  /** The platform's view_image (worker-side; docs/agent-bus.md), offered to every new thread as a dynamic tool. */
  viewImage?(threadId: string, path: string): Promise<ViewImageResult>;
  /** Adds what the transcript shows of an event (image previews) before it is journaled. */
  enrich?(init: ThreadEventInit): Promise<ThreadEventInit>;
  /** Account connectors (Codex apps) are on for this worker (NativeToolsConfig.connectors): list them for mentions. */
  readonly connectors?: boolean;
}

/**
 * Name of the platform's view_image among Codex's dynamic tools. Codex has a built-in tool of that name (local image
 * files for models that take images), so the platform's is namespaced (docs/codex-adapter.md, "view_image").
 */
export const CODEX_VIEW_IMAGE_TOOL = "view_image";
export const CODEX_VIEW_IMAGE_NAMESPACE = "openagents";

export function codexViewImageTool(): v2.DynamicToolSpec {
  const spec = viewImageSpec();
  return {
    type: "namespace",
    name: CODEX_VIEW_IMAGE_NAMESPACE,
    description: "Canopy platform tools.",
    tools: [{ type: "function", name: CODEX_VIEW_IMAGE_TOOL, description: spec.description, inputSchema: spec.inputSchema as v2.DynamicToolFunctionSpec["inputSchema"] }],
  };
}

/**
 * Agent bus tools for a thread, as Codex dynamic tools. Codex accepts them only in thread/start and keeps
 * them with the thread (verified live: across resume in a new process and in forks). A fork therefore has
 * its source's tools; the gateway authorizes every call by the caller's depth anyway.
 * Goals are Codex's own (thread/goal/*), not agent bus tools.
 */
export function codexAgentBusTools(depth: number): v2.DynamicToolSpec[] {
  return agentBusToolSpecs(agentBusToolsFor(depth)).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as v2.DynamicToolFunctionSpec["inputSchema"],
  }));
}

/** Dynamic tools of a new thread: the agent bus (when enabled) and view_image. */
function dynamicTools(spec: ThreadSpec, viewImage: boolean): { dynamicTools?: v2.DynamicToolSpec[] } {
  const tools = [...(spec.enableAgentBus ? codexAgentBusTools(spec.depth) : []), ...(viewImage ? [codexViewImageTool()] : []),
    ...spec.connectorTools.map((t): v2.DynamicToolSpec => ({ type: "function", name: t.name, description: t.description,
      inputSchema: JSON.parse(t.inputSchemaJson) as v2.DynamicToolFunctionSpec["inputSchema"] }))];
  return tools.length > 0 ? { dynamicTools: tools } : {};
}

export function isViewImageCall(call: { namespace?: string | null; tool: string }): boolean {
  return call.tool === CODEX_VIEW_IMAGE_TOOL && call.namespace === CODEX_VIEW_IMAGE_NAMESPACE;
}

export class CodexThreads extends Context.Service<
  CodexThreads,
  {
    /** Creates the Codex thread (new or fork) and records thread_ready. Returns the Codex thread id. */
    create(spec: ThreadSpec, fork?: ForkSpec): Effect.Effect<string, CodexThreadError>;
    /** Starts a turn; resumes the Codex thread first when this process has not loaded it. */
    startTurn(spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings): Effect.Effect<string, CodexThreadError>;
    interrupt(threadId: string, turnId: string): Effect.Effect<void, CodexThreadError>;
    /** Adds input to the running turn (turn/steer); idempotent by inputId. */
    steer(threadId: string, turnId: string, inputId: string, input: UserInput): Effect.Effect<void, SteerError>;
    /** Models a profile offers (model/list, plus the proxy's models for a CLIProxyAPI profile). */
    listModels(profileId: string): Effect.Effect<{ models: ModelInit[]; detail?: string }, CodexThreadError>;
    /** Skills, plugins and apps for the composer in a folder (codex/catalog.ts); refresh = re-scan skills. */
    listMentionCatalog(cwd: string, refresh: boolean): Effect.Effect<{ entries: MentionEntryInit[]; notes: string[] }, CodexThreadError>;
    /** Sets, pauses, resumes, completes or clears the thread's Codex goal (docs/goals.md). */
    setGoal(spec: ThreadSpec, directive: GoalDirective, objective: string, tokenBudget: bigint): Effect.Effect<void, CodexThreadError>;
    /** Terminates a background process (task id = Codex process id). */
    stopTask(threadId: string, taskId: string): Effect.Effect<void, CodexThreadError>;
    /** Background processes still running, per platform thread. */
    backgroundTasks(): ReadonlyMap<string, readonly string[]>;
    /** Why this runtime cannot serve any more (its app-server process exited), else undefined. */
    failure(): string | undefined;
    /** The platform thread is loaded in this process (started or resumed here). */
    has(threadId: string): boolean;
  }
>()("open-agents/worker/CodexThreads") {
  static readonly layer = (options: CodexThreadsOptions) => {
    // The app-server needs the request handler before the registry exists; route through a reference.
    let route: ServerRequestHandler = async (request) => {
      throw new RpcError(request.method, -32601, "not ready");
    };
    return Layer.effect(CodexThreads, make(options, (handler) => (route = handler))).pipe(
      Layer.provide(
        CodexAppServer.layer({
          launch: options.launch,
          clientVersion: options.clientVersion,
          onServerRequest: (request) => route(request),
        }),
      ),
    );
  };
}

interface Entry {
  readonly platformId: string;
  readonly codexId: string;
  readonly mapper: CodexEventMapper;
  /** Platform turn ids waiting for their Codex turn id (turn/started may arrive before the response). */
  readonly pendingTurns: string[];
  readonly codexToPlatform: Map<string, string>;
  readonly platformToCodex: Map<string, string>;
  readonly commandTurns: Set<string>;
  /** Codex's rollout of the thread: items app-server does not notify about (docs/codex-adapter.md, "Code mode"). */
  readonly rollout: { readonly tail: RolloutTail; turn?: string | undefined; readonly ended: Set<string> } | undefined;
  /** Codex turns that completed: a steer for them falls back to the queue. */
  readonly finishedTurns: Set<string>;
  /** Steered inputs (SteerTurn.input_id) accepted by Codex. */
  readonly steered: Set<string>;
  /** Mentions of the platform's inputs by client id (turn id, steer input id), put on Codex's userMessage echo. */
  readonly mentions: Map<string, readonly Mention[]>;
  /** Codex turns the platform asked to interrupt (their interruption is the user's). */
  readonly interrupting: Set<string>;
  readonly rolloutPath: string | null;
}

/**
 * Codex echoes the input as a userMessage item with the platform's client id; the transcript keeps its mentions so the
 * UI shows them as chips (the echo's text is the input text the ranges point into).
 */
export function withUserMentions(init: ThreadEventInit, mentions: ReadonlyMap<string, readonly Mention[]>): ThreadEventInit {
  const body = init.body;
  if (body?.case !== "itemStarted" && body?.case !== "itemCompleted") return init;
  const content = body.value?.item?.content;
  if (content?.case !== "userMessage" || !content.value?.clientId) return init;
  const found = mentions.get(content.value.clientId);
  if (!found) return init;
  return {
    ...init,
    body: { ...body, value: { ...body.value, item: { ...body.value?.item, content: { ...content, value: { ...content.value, mentions: [...found] } } } } },
  } as ThreadEventInit;
}

/** thread/resume of a thread without a rollout file (it never had a turn): "no rollout found for thread id …". */
const NO_ROLLOUT = /no rollout found/i;

const make = (options: CodexThreadsOptions, setRoute: (handler: ServerRequestHandler) => void) =>
  Effect.gen(function* () {
    const codex = yield* CodexAppServer;
    const journal = yield* Journal;
    const byPlatform = new Map<string, Entry>();
    const byCodex = new Map<string, Entry>();
    const connectorCatalog = new Map<string, ThreadSpec["connectorTools"]>();

    const fail = (threadId: string, operation: string) => (error: { message: string }) =>
      new CodexThreadError({ threadId, operation, message: error.message, ...(isAppServerError(error) && { harness: true }) });
    /** Set when the app-server process exited: nothing more runs here. */
    let failure: string | undefined;

    const register = (platformId: string, codexId: string, rolloutPath: string | null): Entry => {
      const pendingTurns: string[] = [];
      const codexToPlatform = new Map<string, string>();
      const platformToCodex = new Map<string, string>();
      const commandTurns = new Set<string>();
      const interrupting = new Set<string>();
      const bind = (codexTurn: string, platformTurn: string) => {
        codexToPlatform.set(codexTurn, platformTurn);
        platformToCodex.set(platformTurn, codexTurn);
      };
      const mapper = new CodexEventMapper({
        turnId: (codexTurn) => codexToPlatform.get(codexTurn),
        startTurn: (codexTurn) => {
          const known = codexToPlatform.get(codexTurn);
          if (known) return known;
          const pending = pendingTurns.shift();
          if (pending) {
            commandTurns.add(codexTurn);
            bind(codexTurn, pending);
            return pending;
          }
          const providerTurn = Bun.randomUUIDv7(); // e.g. goal continuation started by Codex
          bind(codexTurn, providerTurn);
          return providerTurn;
        },
        isCommandTurn: (codexTurn) => commandTurns.has(codexTurn),
        interruptRequested: (codexTurn) => interrupting.has(codexTurn),
      });
      const rollout = rolloutPath ? { tail: new RolloutTail(rolloutPath), ended: new Set<string>() } : undefined;
      const entry: Entry = {
        platformId,
        codexId,
        mapper,
        pendingTurns,
        codexToPlatform,
        platformToCodex,
        commandTurns,
        rollout,
        finishedTurns: new Set(),
        steered: new Set(),
        mentions: new Map(),
        interrupting,
        rolloutPath,
      };
      byPlatform.set(platformId, entry);
      byCodex.set(codexId, entry);
      return entry;
    };

    /** New rollout items of turns started in this process, as the notification the mapper reads. */
    const rolloutItems = (entry: Entry): ServerNotification[] => {
      const rollout = entry.rollout;
      if (!rollout) return [];
      const items: ServerNotification[] = [];
      for (const line of rollout.tail.read()) {
        if (line.kind === "turn") {
          // Turns of other processes (forked or resumed history) are skipped.
          rollout.turn = !line.ended && entry.codexToPlatform.has(line.turnId) ? line.turnId : undefined;
          if (line.ended) rollout.ended.add(line.turnId);
        } else if (rollout.turn) {
          items.push({ method: "rawResponseItem/completed", params: { threadId: entry.codexId, turnId: rollout.turn, item: line.item } });
        }
      }
      return items;
    };

    /** Read on item notifications; before turn/completed, until the turn's end is in the file (written asynchronously). */
    const fromRollout = (entry: Entry, notification: ServerNotification) =>
      Effect.gen(function* () {
        if (notification.method === "item/started" || notification.method === "item/completed") return rolloutItems(entry);
        if (notification.method !== "turn/completed" || !entry.rollout) return [];
        const turnId = notification.params.turn.id;
        const items = rolloutItems(entry);
        for (let attempt = 0; !entry.rollout.ended.delete(turnId) && attempt < 40; attempt++) {
          yield* Effect.sleep("25 millis");
          items.push(...rolloutItems(entry));
        }
        return items;
      });

    const record = (entry: Entry, notification: ServerNotification) =>
      Effect.gen(function* () {
        const notifications = [...(yield* fromRollout(entry, notification)), notification];
        if (notification.method === "turn/completed") entry.finishedTurns.add(notification.params.turn.id);
        const inits = notifications.flatMap((n) => entry.mapper.map(n));
        // Where Codex records this turn: read to settle it if its end never arrives (worker restart, crash).
        if (notification.method === "turn/started" && entry.rolloutPath) {
          const codexTurn = notification.params.turn.id;
          const turnId = entry.codexToPlatform.get(codexTurn);
          if (turnId) {
            yield* journal
              .noteHarness(entry.platformId, turnId, { harness: "codex", transcript: entry.rolloutPath, sessionId: entry.codexId, offset: 0, providerTurn: codexTurn })
              .pipe(Effect.ignore);
          }
        }
        return yield* Effect.forEach(inits.map((init) => withUserMentions(init, entry.mentions)), (init) =>
          (options.enrich ? Effect.promise(() => options.enrich!(init)) : Effect.succeed(init)).pipe(
            Effect.flatMap((enriched) => journal.append(entry.platformId, enriched)),
            Effect.tap((event) => Effect.sync(() => options.publish(event))),
          ),
        );
      });

    /**
     * The app-server exited on its own: every turn it ran ends the way its rollout says, else as failed in the
     * harness (its process is gone). Background processes died with it (the host closes them when it restarts
     * the runtime).
     */
    const settleAfterExit = (code: number | null) =>
      Effect.gen(function* () {
        // The last line that says what went wrong (warnings are noise here).
        const stderr = codex
          .stderrTail()
          .split("\n")
          .filter((line) => /error|panic|fatal/i.test(line))
          .at(-1)
          ?.slice(0, 500);
        failure = `codex app-server exited (code ${code ?? "?"})${stderr ? `: ${stderr}` : ""}`;
        const running = new Set<string>();
        for (const entry of byPlatform.values()) {
          for (const [codexTurn, turnId] of entry.codexToPlatform) if (!entry.finishedTurns.has(codexTurn)) running.add(`${entry.platformId}/${turnId}`);
        }
        const open = (yield* journal.openTurns()).filter((t) => running.has(`${t.threadId}/${t.turnId}`));
        for (const turn of open) {
          const { events } = yield* reconcileTurn(turn, {
            outcome: TurnOutcome.FAILED,
            source: TurnEndSource.HARNESS,
            reason: `harness process exited (code ${code ?? "?"})${stderr ? `: ${stderr}` : ""}`,
            errorCode: "process_exit",
          }).pipe(Effect.provideService(Journal, journal));
          for (const event of events) options.publish(event);
        }
        for (const entry of byPlatform.values()) for (const codexTurn of entry.codexToPlatform.keys()) entry.finishedTurns.add(codexTurn);
      });
    // Interrupted (before the process is killed) when the runtime closes on purpose.
    yield* Effect.forkScoped(codex.exited.pipe(Effect.flatMap(settleAfterExit), Effect.ignore));

    // One consumer, in order, for every notification of every loaded thread.
    yield* Effect.forkScoped(
      codex.notifications.pipe(
        Stream.runForEach((notification) => {
          const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
          const entry = typeof threadId === "string" ? byCodex.get(threadId) : undefined;
          return entry ? record(entry, notification).pipe(Effect.ignore) : Effect.void;
        }),
      ),
    );

    setRoute(async (request) => {
      const params = request.params as { threadId?: string; turnId?: string; itemId?: string } & Record<string, unknown>;
      const entry = params.threadId ? byCodex.get(params.threadId) : undefined;
      const interact = (kind: InteractionKind, toolName: string) => {
        if (!entry) throw new RpcError(request.method, -32602, "unknown thread");
        return options.interact(
          create(InteractionRequestSchema, {
            requestId: Bun.randomUUIDv7(),
            threadId: entry.platformId,
            turnId: params.turnId ? (entry.codexToPlatform.get(params.turnId) ?? "") : "",
            itemId: params.itemId ?? "",
            kind,
            toolName,
            requestJson: JSON.stringify(params),
          }),
        );
      };
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": {
          const answer = await interact(InteractionKind.PERMISSION, request.method.includes("command") ? "shell" : "apply_patch");
          return { decision: answer.cancelled ? "cancel" : answer.allow ? (answer.allowForSession ? "acceptForSession" : "accept") : "decline" };
        }
        case "item/permissions/requestApproval": {
          const answer = await interact(InteractionKind.PERMISSION, "permissions");
          const requested = (request.params as v2.PermissionsRequestApprovalParams).permissions;
          return { permissions: answer.allow ? requested : {}, scope: answer.allowForSession ? "session" : "turn" };
        }
        case "item/tool/requestUserInput": {
          const answer = await interact(InteractionKind.QUESTION, "request_user_input");
          return { answers: answer.cancelled || !answer.answerJson ? {} : JSON.parse(answer.answerJson) };
        }
        case "mcpServer/elicitation/request": {
          const answer = await interact(InteractionKind.ELICITATION, "mcp_elicitation");
          return answer.cancelled || !answer.answerJson ? { action: "decline" } : { action: "accept", content: JSON.parse(answer.answerJson) };
        }
        case "item/tool/call": {
          if (!entry) throw new RpcError(request.method, -32602, "unknown thread");
          const call = request.params as v2.DynamicToolCallParams;
          if (isViewImageCall(call) && options.viewImage) {
            const args = (call.arguments ?? {}) as { path?: unknown };
            const viewed = await options.viewImage(entry.platformId, typeof args.path === "string" ? args.path : "");
            return (
              viewed.ok
                ? { contentItems: [{ type: "inputImage", imageUrl: `data:${viewed.mimeType};base64,${viewed.base64}` }, { type: "inputText", text: viewed.summary }], success: true }
                : { contentItems: [{ type: "inputText", text: viewed.message }], success: false }
            ) satisfies v2.DynamicToolCallResponse;
          }
          const result = await options.callTool(
            create(AgentToolCallSchema, {
              callId: toolCallId(entry.platformId, call.callId),
              threadId: entry.platformId,
              turnId: entry.codexToPlatform.get(call.turnId) ?? "",
              itemId: call.callId,
              toolName: call.tool,
              connectorAccountId: connectorCatalog.get(entry.platformId)?.find((t) => t.name === call.tool)?.accountId ?? "",
              argumentsJson: JSON.stringify(call.arguments ?? {}),
            }),
          );
          return { contentItems: [{ type: "inputText", text: result.content }], success: !result.isError } satisfies v2.DynamicToolCallResponse;
        }
        case "currentTime/read":
          return { currentTime: new Date().toISOString() };
        default:
          throw new RpcError(request.method, -32601, "not supported by open-agents worker");
      }
    });

    const threadParams = (spec: ThreadSpec) => {
      connectorCatalog.set(spec.threadId, spec.connectorTools);
      const profile = options.profile(spec.providerProfileId);
      if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
      return {
        cwd: spec.cwd,
        ...(spec.model && { model: spec.model }),
        ...(spec.instructions && { developerInstructions: spec.instructions }),
        ...codexPermissions(spec.permissionMode),
        ...codexThreadProvider(profile),
      };
    };

    // The bundled catalog (the same for every model provider), listed once per process.
    let catalog: v2.Model[] | undefined;
    const loadCatalog = Effect.gen(function* () {
      if (catalog) return catalog;
      const models: v2.Model[] = [];
      let cursor: string | null = null;
      do {
        const page: v2.ModelListResponse = yield* codex.request("model/list", { includeHidden: true, ...(cursor && { cursor }) });
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      catalog = models;
      return models;
    });

    /**
     * Every turn names its model, effort and permission mode: Codex keeps a turn's override for the turns after
     * it, so a turn without an override goes back to the catalog's default model and the default effort the
     * catalog reports for it (the device owner's configured one when the model offers it, else the model's own),
     * and to the thread's permission mode. Approvals already pending in a running turn keep their own policy.
     */
    const turnSettings = (spec: ThreadSpec, settings: TurnSettings | undefined) =>
      Effect.gen(function* () {
        const models = yield* loadCatalog.pipe(Effect.orElseSucceed((): v2.Model[] => []));
        const model = settings?.model || spec.model || models.find((m) => m.isDefault)?.model || "";
        const listed = models.find((m) => m.model === model);
        const effort =
          settings?.effort ||
          (listed && pickDefaultEffort(listed.supportedReasoningEfforts.map((e) => e.reasoningEffort), options.configuredEffort?.(), listed.defaultReasoningEffort)) ||
          "";
        return { ...(model && { model }), ...(effort && { effort }), ...codexTurnPermissions(settings?.permissionMode || spec.permissionMode) };
      });

    const announce = (entry: Entry, replaces = "") =>
      journal
        .append(entry.platformId, {
          body: { case: "threadReady", value: { providerThreadId: entry.codexId, ...(replaces && { replacesProviderThreadId: replaces }) } },
        })
        .pipe(Effect.tap((event) => Effect.sync(() => options.publish(event))));

    const startThread = (spec: ThreadSpec, params: ReturnType<typeof threadParams>, operation: string) =>
      codex
        .request("thread/start", { ...params, ...dynamicTools(spec, options.viewImage !== undefined) })
        .pipe(Effect.mapError(fail(spec.threadId, operation)));

    const ensureLoaded = (spec: ThreadSpec) =>
      Effect.gen(function* () {
        const loaded = byPlatform.get(spec.threadId);
        if (loaded) return loaded;
        if (!spec.providerThreadId) {
          return yield* new CodexThreadError({ threadId: spec.threadId, operation: "resume", message: "thread was never created on Codex" });
        }
        const params = yield* Effect.try({ try: () => threadParams(spec), catch: (e) => fail(spec.threadId, "resume")(e as Error) });
        const resumed = yield* codex.request("thread/resume", { threadId: spec.providerThreadId, ...params }).pipe(
          Effect.map((response) => response.thread),
          Effect.catch((error) => (NO_ROLLOUT.test(error.message) ? Effect.succeed(undefined) : Effect.fail(fail(spec.threadId, "resume")(error)))),
        );
        if (resumed) return register(spec.threadId, resumed.id, resumed.path);
        // Codex writes a thread's rollout with its first turn: a thread that never had one is gone with the
        // process that created it. Nothing is lost by starting it again; the gateway keeps the platform
        // thread and takes the new Codex id (thread_ready replaces the old one).
        const started = yield* startThread(spec, params, "resume");
        const entry = register(spec.threadId, started.thread.id, started.thread.path);
        yield* announce(entry, spec.providerThreadId).pipe(Effect.mapError(fail(spec.threadId, "journal")));
        return entry;
      });

    return CodexThreads.of({
      create: Effect.fn("CodexThreads.create")(function* (spec: ThreadSpec, fork?: ForkSpec) {
        const params = yield* Effect.try({ try: () => threadParams(spec), catch: (e) => fail(spec.threadId, "create")(e as Error) });
        const response = fork
          ? yield* codex
              .request("thread/fork", {
                threadId: fork.sourceProviderThreadId,
                ...(fork.afterProviderTurnRef && { lastTurnId: fork.afterProviderTurnRef }),
                ...params,
              })
              .pipe(Effect.mapError(fail(spec.threadId, "fork")))
          : yield* startThread(spec, params, "create");
        const entry = register(spec.threadId, response.thread.id, response.thread.path);
        yield* announce(entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));
        return entry.codexId;
      }),

      startTurn: Effect.fn("CodexThreads.startTurn")(function* (spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings) {
        connectorCatalog.set(spec.threadId, spec.connectorTools);
        const entry = yield* ensureLoaded(spec);
        const known = entry.platformToCodex.get(turnId);
        if (known) return known; // redelivered StartTurn: the turn already exists
        const chosen = yield* turnSettings(spec, settings);
        entry.pendingTurns.push(turnId);
        if (input.mentions.length > 0) entry.mentions.set(turnId, input.mentions);
        const response = yield* codex
          .request("turn/start", {
            threadId: entry.codexId,
            clientUserMessageId: turnId,
            input: codexUserInput(input),
            ...chosen,
          })
          .pipe(
            Effect.mapError(fail(spec.threadId, "turn/start")),
            Effect.tapError(() => Effect.sync(() => entry.pendingTurns.splice(entry.pendingTurns.indexOf(turnId), 1))),
          );
        const codexTurn = response.turn.id;
        if (!entry.codexToPlatform.has(codexTurn)) {
          // The response won the race against turn/started: bind now and drop the pending slot.
          entry.pendingTurns.splice(entry.pendingTurns.indexOf(turnId), 1);
          entry.commandTurns.add(codexTurn);
          entry.codexToPlatform.set(codexTurn, turnId);
          entry.platformToCodex.set(turnId, codexTurn);
        }
        return codexTurn;
      }),

      interrupt: Effect.fn("CodexThreads.interrupt")(function* (threadId: string, turnId: string) {
        const entry = byPlatform.get(threadId);
        const codexTurn = entry?.platformToCodex.get(turnId);
        if (!entry || !codexTurn) return yield* new CodexThreadError({ threadId, operation: "interrupt", message: "turn is not running here" });
        entry.interrupting.add(codexTurn);
        yield* codex.request("turn/interrupt", { threadId: entry.codexId, turnId: codexTurn }).pipe(Effect.mapError(fail(threadId, "interrupt")));
      }),

      steer: Effect.fn("CodexThreads.steer")(function* (threadId: string, turnId: string, inputId: string, input: UserInput) {
        const entry = byPlatform.get(threadId);
        if (entry?.steered.has(inputId)) return; // redelivered SteerTurn
        const codexTurn = entry?.platformToCodex.get(turnId);
        if (!entry || !codexTurn || entry.finishedTurns.has(codexTurn)) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn is not running on this worker" });
        }
        if (input.mentions.length > 0) entry.mentions.set(inputId, input.mentions);
        // expectedTurnId: Codex refuses when another turn (or none) is active by now.
        yield* codex
          .request("turn/steer", {
            threadId: entry.codexId,
            expectedTurnId: codexTurn,
            clientUserMessageId: inputId,
            input: codexUserInput(input),
          })
          .pipe(
            Effect.mapError((error) =>
              entry.finishedTurns.has(codexTurn)
                ? new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn ended before the message could join it" })
                : new SteerError({ code: "STEER_REJECTED", message: error.message }),
            ),
          );
        entry.steered.add(inputId);
      }),

      listModels: Effect.fn("CodexThreads.listModels")(function* (profileId: string) {
        const profile = options.profile(profileId);
        if (!profile) return yield* new CodexThreadError({ threadId: "", operation: "model/list", message: `provider profile "${profileId || "native"}" is not available` });
        // A fresh list: model/list again, not the process's cached catalog.
        catalog = undefined;
        const configured = options.configuredEffort?.();
        const models = (yield* loadCatalog.pipe(Effect.mapError(fail("", "model/list")))).map((m) => codexModel(m, configured));
        if (profile.kind !== "cliproxyapi") return { models };
        return yield* Effect.tryPromise(() => proxyModels(profile)).pipe(
          Effect.map((served) => ({ models: codexProxyModels(models, served) })),
          Effect.catch((error) => Effect.succeed({ models, detail: `the proxy's models are unknown: ${error instanceof Error ? error.message : String(error)}` })),
        );
      }),
      listMentionCatalog: Effect.fn("CodexThreads.listMentionCatalog")(function* (cwd: string, refresh: boolean) {
        const skills = codexSkillEntries(yield* codex.request("skills/list", { cwds: [cwd], forceReload: refresh }).pipe(Effect.mapError(fail("", "skills/list"))));
        const notes = [...skills.notes, "commands: Codex runs no slash commands from turn input (its /commands belong to the Codex TUI)"];
        const plugins = yield* codex.request("plugin/list", { cwds: [cwd] }).pipe(
          Effect.map(codexPluginEntries),
          Effect.catch((error) => Effect.sync(() => (notes.push(`plugins: ${error.message}`), []))),
        );
        let apps: MentionEntryInit[] = [];
        if (options.connectors) {
          apps = yield* codex.request("app/list", { forceRefetch: refresh }).pipe(
            Effect.map(codexAppEntries),
            Effect.catch((error) => Effect.sync(() => (notes.push(`apps: ${error.message}`), []))),
          );
        } else {
          notes.push("apps: account connectors are off on this worker");
        }
        return { entries: [...skills.entries, ...plugins, ...apps], notes };
      }),
      setGoal: Effect.fn("CodexThreads.setGoal")(function* (spec: ThreadSpec, directive: GoalDirective, objective: string, tokenBudget: bigint) {
        const entry = yield* ensureLoaded(spec);
        // origin "user": the platform acts for the user who set the goal in the UI.
        const set = (params: Omit<v2.ThreadGoalSetParams, "threadId" | "origin">) =>
          codex.request("thread/goal/set", { threadId: entry.codexId, origin: "user", ...params }).pipe(Effect.asVoid);
        const request = (() => {
          switch (directive) {
            case GoalDirective.RUN:
              // With an objective: a new goal (replaces the current one); without: resume.
              return objective
                ? set({ objective, status: "active", tokenBudget: tokenBudget > 0n ? Number(tokenBudget) : null })
                : set({ status: "active" });
            case GoalDirective.PAUSE:
              return set({ status: "paused" });
            case GoalDirective.COMPLETE:
              return set({ status: "complete" });
            case GoalDirective.CLEAR:
              return codex.request("thread/goal/clear", { threadId: entry.codexId, origin: "user" }).pipe(Effect.asVoid);
            default:
              return Effect.fail({ message: `unknown goal directive ${directive}` });
          }
        })();
        yield* request.pipe(Effect.mapError(fail(spec.threadId, "goal")));
      }),

      stopTask: Effect.fn("CodexThreads.stopTask")(function* (threadId: string, taskId: string) {
        const entry = byPlatform.get(threadId);
        const processId = entry?.mapper.markStopping(taskId);
        if (!entry || !processId) return yield* new CodexThreadError({ threadId, operation: "stop", message: "the task is not running here" });
        yield* codex
          .request("thread/backgroundTerminals/terminate", { threadId: entry.codexId, processId })
          .pipe(Effect.mapError(fail(threadId, "stop")));
      }),

      backgroundTasks: () =>
        new Map([...byPlatform.values()].flatMap((entry) => (entry.mapper.backgroundTasks.length > 0 ? [[entry.platformId, entry.mapper.backgroundTasks] as const] : []))),

      failure: () => failure,

      has: (threadId) => byPlatform.has(threadId),
    });
  });

function isAppServerError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "CodexAppServerError";
}
