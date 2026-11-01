import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { ServerNotification, v2 } from "@open-agents/codex-protocol";
import {
  AgentToolCallSchema,
  InteractionKind,
  InteractionRequestSchema,
  type AgentToolCall,
  type AgentToolResult,
  type ForkSpec,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadEvent,
  type ThreadSpec,
  type UserInput,
} from "@open-agents/contracts";
import { agentBusToolSpecs, agentBusToolsFor } from "@open-agents/domain";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Journal } from "../../journal/index.ts";
import { codexModel, codexProxyModels, proxyModels, type ModelInit } from "../models.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import { toolCallId } from "../tool-call-id.ts";
import { CodexAppServer, type ServerRequestHandler } from "./app-server.ts";
import { codexThreadProvider, type CodexAppServerLaunch } from "./launch.ts";
import { CodexEventMapper } from "./mapping.ts";
import { codexPermissions } from "./permissions.ts";
import { RolloutTail } from "./rollout.ts";
import { RpcError } from "./rpc.ts";

/**
 * Platform threads on Codex (docs/codex-adapter.md): commands -> app-server requests,
 * notifications -> mapper -> journal (first) -> publish. One registry entry per loaded thread.
 */

export class CodexThreadError extends Schema.TaggedError<CodexThreadError>()("CodexThreadError", {
  threadId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
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
}

/**
 * Agent bus tools for a thread, as Codex dynamic tools. Codex accepts them only in thread/start and keeps
 * them with the thread (verified live: across resume in a new process and in forks). A fork therefore has
 * its source's tools; the gateway authorizes every call by the caller's depth anyway.
 * Goal tools only come with the platform goal engine (the default is Codex's native goals).
 */
export function codexAgentBusTools(depth: number): v2.DynamicToolSpec[] {
  return agentBusToolSpecs(agentBusToolsFor(depth)).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as v2.DynamicToolFunctionSpec["inputSchema"],
  }));
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
}

const make = (options: CodexThreadsOptions, setRoute: (handler: ServerRequestHandler) => void) =>
  Effect.gen(function* () {
    const codex = yield* CodexAppServer;
    const journal = yield* Journal;
    const byPlatform = new Map<string, Entry>();
    const byCodex = new Map<string, Entry>();

    const fail = (threadId: string, operation: string) => (error: { message: string }) =>
      new CodexThreadError({ threadId, operation, message: error.message });

    const register = (platformId: string, codexId: string, rolloutPath: string | null): Entry => {
      const pendingTurns: string[] = [];
      const codexToPlatform = new Map<string, string>();
      const platformToCodex = new Map<string, string>();
      const commandTurns = new Set<string>();
      const bind = (codexTurn: string, platformTurn: string) => {
        codexToPlatform.set(codexTurn, platformTurn);
        platformToCodex.set(platformTurn, codexTurn);
      };
      const mapper = new CodexEventMapper({
        turnId: (codexTurn) => {
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
        return yield* Effect.forEach(notifications.flatMap((n) => entry.mapper.map(n)), (init) =>
          journal.append(entry.platformId, init).pipe(Effect.tap((event) => Effect.sync(() => options.publish(event)))),
        );
      });

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
          const result = await options.callTool(
            create(AgentToolCallSchema, {
              callId: toolCallId(entry.platformId, call.callId),
              threadId: entry.platformId,
              turnId: entry.codexToPlatform.get(call.turnId) ?? "",
              itemId: call.callId,
              toolName: call.tool,
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
     * Every turn names its model and effort: Codex keeps a turn's override for the turns after it, so a turn
     * without an override goes back to the catalog's default model and that model's default effort.
     */
    const turnSettings = (spec: ThreadSpec, settings: TurnSettings | undefined) =>
      Effect.gen(function* () {
        const models = yield* loadCatalog.pipe(Effect.orElseSucceed((): v2.Model[] => []));
        const model = settings?.model || spec.model || models.find((m) => m.isDefault)?.model || "";
        const effort = settings?.effort || models.find((m) => m.model === model)?.defaultReasoningEffort || "";
        return { ...(model && { model }), ...(effort && { effort }) };
      });

    const announce = (entry: Entry) =>
      journal
        .append(entry.platformId, { body: { case: "threadReady", value: { providerThreadId: entry.codexId } } })
        .pipe(Effect.tap((event) => Effect.sync(() => options.publish(event))));

    const ensureLoaded = (spec: ThreadSpec) =>
      Effect.gen(function* () {
        const loaded = byPlatform.get(spec.threadId);
        if (loaded) return loaded;
        if (!spec.providerThreadId) {
          return yield* new CodexThreadError({ threadId: spec.threadId, operation: "resume", message: "thread was never created on Codex" });
        }
        const params = yield* Effect.try({ try: () => threadParams(spec), catch: (e) => fail(spec.threadId, "resume")(e as Error) });
        const resumed = yield* codex
          .request("thread/resume", { threadId: spec.providerThreadId, ...params })
          .pipe(Effect.mapError(fail(spec.threadId, "resume")));
        return register(spec.threadId, resumed.thread.id, resumed.thread.path);
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
          : yield* codex
              .request("thread/start", { ...params, ...(spec.enableAgentBus && { dynamicTools: codexAgentBusTools(spec.depth) }) })
              .pipe(Effect.mapError(fail(spec.threadId, "create")));
        const entry = register(spec.threadId, response.thread.id, response.thread.path);
        yield* announce(entry).pipe(Effect.mapError(fail(spec.threadId, "journal")));
        return entry.codexId;
      }),

      startTurn: Effect.fn("CodexThreads.startTurn")(function* (spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings) {
        const entry = yield* ensureLoaded(spec);
        const known = entry.platformToCodex.get(turnId);
        if (known) return known; // redelivered StartTurn: the turn already exists
        const chosen = yield* turnSettings(spec, settings);
        entry.pendingTurns.push(turnId);
        const response = yield* codex
          .request("turn/start", {
            threadId: entry.codexId,
            clientUserMessageId: turnId,
            input: [{ type: "text", text: input.text, text_elements: [] }],
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
        yield* codex.request("turn/interrupt", { threadId: entry.codexId, turnId: codexTurn }).pipe(Effect.mapError(fail(threadId, "interrupt")));
      }),

      steer: Effect.fn("CodexThreads.steer")(function* (threadId: string, turnId: string, inputId: string, input: UserInput) {
        const entry = byPlatform.get(threadId);
        if (entry?.steered.has(inputId)) return; // redelivered SteerTurn
        const codexTurn = entry?.platformToCodex.get(turnId);
        if (!entry || !codexTurn || entry.finishedTurns.has(codexTurn)) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn is not running on this worker" });
        }
        // expectedTurnId: Codex refuses when another turn (or none) is active by now.
        yield* codex
          .request("turn/steer", {
            threadId: entry.codexId,
            expectedTurnId: codexTurn,
            clientUserMessageId: inputId,
            input: [{ type: "text", text: input.text, text_elements: [] }],
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
        const models = (yield* loadCatalog.pipe(Effect.mapError(fail("", "model/list")))).map(codexModel);
        if (profile.kind !== "cliproxyapi") return { models };
        return yield* Effect.tryPromise(() => proxyModels(profile)).pipe(
          Effect.map((served) => ({ models: codexProxyModels(models, served) })),
          Effect.catch((error) => Effect.succeed({ models, detail: `the proxy's models are unknown: ${error instanceof Error ? error.message : String(error)}` })),
        );
      }),
    });
  });
