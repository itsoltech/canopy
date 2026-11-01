import { create } from "@bufbuild/protobuf";
import { forkSession, getSessionMessages, query, type CanUseTool, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  InteractionKind,
  InteractionRequestSchema,
  ItemStatus,
  NoticeLevel,
  TurnOrigin,
  TurnOutcome,
  type AgentToolCall,
  type AgentToolResult,
  type ForkSpec,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadEvent,
  type ThreadSpec,
  type UserInput,
} from "@open-agents/contracts";
import { AsyncChannel } from "@open-agents/transport";
import { Context, Effect, Layer, Schema } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import { claudeModel, isClaudeEffort, type ModelInit } from "../models.ts";
import { claudeNativeToolOptions, type NativeToolPolicy } from "../native-tools.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import type { Env, ResolvedProfile } from "../profiles.ts";
import { claudeBusServer, claudeBusToolNames } from "./bus.ts";
import { BUS_SERVER, ClaudeEventMapper } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { claudeProfileOptions } from "./profile.ts";

/**
 * Platform threads on Claude Code through the Agent SDK (docs/claude-adapter.md).
 *
 * - A thread is a Claude session. Its id is chosen by the platform (the thread id), so thread_ready
 *   is recorded at creation without calling the model; a fork copies the source session up to the
 *   fork point (forkSession) and gets a new session id.
 * - A turn is one query(): a new session with sessionId on the first turn, resume afterwards.
 *   Events go to the journal first, then to the gateway (publish), in order.
 * - The prompt is a stream (streaming input): the turn's input first, then steered messages
 *   (priority "next": Claude Code takes them in between tool calls). A steered message that is still
 *   queued at the result runs right after it in the same query, so the turn goes on until it has run.
 * - Permission prompts and questions go to the platform (interact); agent bus tools to the gateway (callTool).
 * - Native subagents and schedulers are disallowed (native-tools.ts); the bus replaces them.
 */

export class ClaudeThreadError extends Schema.TaggedError<ClaudeThreadError>()("ClaudeThreadError", {
  threadId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface ClaudeThreadsOptions {
  /** Isolated Claude config dir (CLAUDE_CONFIG_DIR, claude/home.ts). */
  readonly home: string;
  /** Claude Code executable; the SDK's bundled one when absent. */
  readonly executable?: string;
  readonly nativeTools: NativeToolPolicy;
  readonly baseEnv: Env;
  profile(id: string): ResolvedProfile | undefined;
  publish(event: ThreadEvent): void;
  interact(request: InteractionRequest): Promise<InteractionResponse>;
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
}

export class ClaudeThreads extends Context.Service<
  ClaudeThreads,
  {
    /** Records thread_ready with the session id (forked session for a fork). Returns the session id. */
    create(spec: ThreadSpec, fork?: ForkSpec): Effect.Effect<string, ClaudeThreadError>;
    /** Starts a turn and returns once it runs; the turn streams into the journal in the background. */
    startTurn(spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings): Effect.Effect<void, ClaudeThreadError>;
    interrupt(threadId: string, turnId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Adds input to the running turn (the prompt stream); idempotent by inputId. */
    steer(threadId: string, turnId: string, inputId: string, input: UserInput): Effect.Effect<void, SteerError>;
    /** Whether a turn of this thread runs in this process. */
    running(threadId: string): boolean;
    /** Models a profile offers (Query.supportedModels() without a prompt; no model turn). */
    listModels(profileId: string): Effect.Effect<{ models: ModelInit[] }, ClaudeThreadError>;
  }
>()("open-agents/worker/ClaudeThreads") {
  static readonly layer = (options: ClaudeThreadsOptions) => Layer.effect(ClaudeThreads, make(options));
}

interface ActiveTurn {
  readonly turnId: string;
  readonly query: Query;
  readonly mapper: ClaudeEventMapper;
  readonly abort: AbortController;
  /** Bus tool_use ids by "name args" from streamed assistant messages, for the MCP handler. */
  readonly busCalls: Map<string, string[]>;
  readonly done: Promise<void>;
  /** The prompt stream: the turn's input, then steered messages. */
  readonly prompt: AsyncChannel<SDKUserMessage>;
  /** Steered inputs by input id; started once Claude Code took them into the turn (command_lifecycle). */
  readonly steers: Map<string, { readonly text: string; readonly authorUserId: string; started: boolean }>;
  /** The turn is finishing (result seen, or interrupted): no more steers. */
  ended: boolean;
  interrupting: boolean;
}

/** How long a turn waits after a result for a steered message Claude Code has not taken yet. */
const STEER_GRACE_MS = 60_000;

const make = (options: ClaudeThreadsOptions) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const active = new Map<string, ActiveTurn>();
    /** Turns started in this process, so a redelivered StartTurn does not run twice. */
    const started = new Set<string>();
    // Session helpers (forkSession, getSessionMessages) run in this process and read CLAUDE_CONFIG_DIR here.
    process.env["CLAUDE_CONFIG_DIR"] = options.home;

    const fail = (threadId: string, operation: string) => (error: unknown) =>
      new ClaudeThreadError({ threadId, operation, message: error instanceof Error ? error.message : String(error) });

    const record = (threadId: string, init: ThreadEventInit) =>
      Effect.runPromise(journal.append(threadId, init).pipe(Effect.tap((event) => Effect.sync(() => options.publish(event)))));

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const turn of active.values()) turn.abort.abort();
        await Promise.allSettled([...active.values()].map((t) => t.done));
      }),
    );

    const sessionExists = async (sessionId: string, cwd: string) => {
      try {
        return (await getSessionMessages(sessionId, { dir: cwd })).length > 0;
      } catch {
        return false;
      }
    };

    const canUseTool =
      (spec: ThreadSpec, turn: () => ActiveTurn | undefined, autoAllow: boolean): CanUseTool =>
      async (toolName, input, context) => {
        if (toolName.startsWith(`mcp__${BUS_SERVER}__`) && context.mcpServer?.source === "sdk") return { behavior: "allow", updatedInput: input };
        const question = toolName === "AskUserQuestion";
        if (autoAllow && !question) return { behavior: "allow", updatedInput: input };
        const answer = await options.interact(
          create(InteractionRequestSchema, {
            requestId: Bun.randomUUIDv7(),
            threadId: spec.threadId,
            turnId: turn()?.turnId ?? "",
            itemId: context.toolUseID,
            kind: question ? InteractionKind.QUESTION : InteractionKind.PERMISSION,
            toolName,
            requestJson: JSON.stringify({
              input,
              ...(context.title && { title: context.title }),
              ...(context.description && { description: context.description }),
              ...(context.decisionReason && { reason: context.decisionReason }),
              ...(context.blockedPath && { blockedPath: context.blockedPath }),
            }),
          }),
        );
        if (answer.cancelled) return { behavior: "deny", message: "cancelled by the user", interrupt: true };
        if (question) {
          const answers = answer.answerJson ? (JSON.parse(answer.answerJson) as unknown) : {};
          return { behavior: "allow", updatedInput: { ...input, answers } };
        }
        return answer.allow
          ? { behavior: "allow", updatedInput: input, ...(answer.allowForSession && context.suggestions && { updatedPermissions: context.suggestions }) }
          : { behavior: "deny", message: answer.message || "denied by the user" };
      };

    const run = async (spec: ThreadSpec, turnId: string, input: UserInput, settings: TurnSettings | undefined) => {
      const profile = options.profile(spec.providerProfileId);
      if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
      const model = settings?.model || spec.model;
      const requested = settings?.effort ?? "";
      if (requested && !isClaudeEffort(requested)) throw new Error(`unknown reasoning effort "${requested}" (Claude: low, medium, high, xhigh, max)`);
      const effort = isClaudeEffort(requested) ? requested : undefined;
      const sessionId = spec.providerThreadId || spec.threadId;
      const resume = await sessionExists(sessionId, spec.cwd);
      const permissions = claudePermissions(spec.permissionMode);
      const abort = new AbortController();
      const mapper = new ClaudeEventMapper(turnId);
      const busCalls = new Map<string, string[]>();
      let current: ActiveTurn | undefined;
      /** A result that did not end the turn (a steered message was still queued): ends it if nothing follows. */
      let deferredResult: ThreadEventInit | undefined;
      const busTools = spec.enableAgentBus ? claudeBusToolNames(spec.depth) : [];
      const queryOptions: Options = {
        cwd: spec.cwd,
        ...(model && { model }),
        ...(effort && { effort }),
        ...claudeProfileOptions(profile, { ...options.baseEnv, CLAUDE_CONFIG_DIR: options.home }),
        ...(options.executable && { pathToClaudeCodeExecutable: options.executable }),
        ...(resume ? { resume: sessionId } : { sessionId }),
        includePartialMessages: true,
        ...permissions.options,
        canUseTool: canUseTool(spec, () => current, permissions.autoAllow),
        // Bus tools pass every mode (dontAsk denies whatever is not pre-approved).
        allowedTools: busTools,
        ...claudeNativeToolOptions(options.nativeTools),
        // Only the platform's MCP servers: the device owner's would leak their tools and accounts.
        strictMcpConfig: true,
        mcpServers: spec.enableAgentBus
          ? {
              [BUS_SERVER]: claudeBusServer({
                threadId: spec.threadId,
                depth: spec.depth,
                turnId: () => turnId,
                toolUseId: (tool, args) => busCalls.get(callKey(tool, args))?.shift(),
                callTool: options.callTool,
              }),
            }
          : {},
        systemPrompt: { type: "preset", preset: "claude_code", ...(spec.instructions && { append: spec.instructions }) },
        abortController: abort,
      };
      const prompt = new AsyncChannel<SDKUserMessage>();
      prompt.push({ type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null });
      const q = query({ prompt, options: queryOptions });
      const steers: ActiveTurn["steers"] = new Map();

      await record(spec.threadId, { turnId, body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND, ...(model && { model }) } } });
      await record(spec.threadId, userItem(turnId, `user:${turnId}`, turnId, input.text, input.authorUserId));

      const release = () => {
        if (active.get(spec.threadId) === current) active.delete(spec.threadId);
      };
      /** Steered messages that never joined the turn: the gateway queues them as the next turn. */
      const dropSteers = async () => {
        for (const [inputId, steer] of steers) {
          if (steer.started) continue;
          steers.delete(inputId);
          await record(spec.threadId, {
            turnId,
            body: {
              case: "notice",
              value: { level: NoticeLevel.WARNING, code: "steer_dropped", message: "the message did not join the turn before it ended", dataJson: JSON.stringify({ input_id: inputId }) },
            },
          }).catch(() => {});
        }
      };
      const done = (async () => {
        let finished = false;
        let stalled = false;
        const messages = q[Symbol.asyncIterator]();
        const finish = async () => {
          // Free the thread before the gateway hears the turn is over: it may start the next one at once.
          finished = true;
          if (current) current.ended = true;
          release();
          await dropSteers();
        };
        try {
          for (;;) {
            // After a deferred result the steered message must start soon; otherwise that result ends the turn.
            const next = deferredResult
              ? await Promise.race([messages.next(), Bun.sleep(STEER_GRACE_MS).then(() => undefined)])
              : await messages.next();
            if (!next && deferredResult) {
              stalled = true;
              const result = deferredResult;
              await finish();
              await record(spec.threadId, result);
              break;
            }
            if (!next || next.done) break;
            const message = next.value;
            deferredResult = undefined;
            const lifecycle = message as unknown as { type: string; command_uuid?: string; state?: string };
            if (lifecycle.type === "command_lifecycle" && lifecycle.state === "started" && lifecycle.command_uuid) {
              const steer = steers.get(lifecycle.command_uuid);
              if (steer && !steer.started) {
                steer.started = true;
                await record(spec.threadId, userItem(turnId, `user:${lifecycle.command_uuid}`, lifecycle.command_uuid, steer.text, steer.authorUserId));
              }
            }
            if (message.type === "assistant") {
              for (const block of message.message.content) {
                if (block.type !== "tool_use" || !block.name.startsWith(`mcp__${BUS_SERVER}__`)) continue;
                const key = callKey(block.name.slice(`mcp__${BUS_SERVER}__`.length), block.input);
                busCalls.set(key, [...(busCalls.get(key) ?? []), block.id]);
              }
            }
            for (const init of mapper.map(message)) {
              if (init.body?.case === "turnFinished") {
                // A steered message still queued in Claude Code runs right after this result: the turn goes on
                // (the result is kept, without its body). An interrupt drops such messages instead.
                if (!current?.interrupting && [...steers.values()].some((s) => !s.started)) {
                  deferredResult = init;
                  await record(spec.threadId, { turnId, rawJson: init.rawJson ?? "" });
                  continue;
                }
                await finish();
              }
              await record(spec.threadId, init);
            }
            // The result ends the turn; leaving the loop closes the query (the session is already saved).
            if (finished) break;
          }
        } catch (error) {
          if (!finished) {
            const interrupted = abort.signal.aborted;
            if (current) current.ended = true;
            release();
            await dropSteers();
            await record(spec.threadId, {
              turnId,
              body: {
                case: "turnFinished",
                value: {
                  outcome: interrupted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED,
                  providerTurnRef: mapper.lastEntry ?? "",
                  reason: interrupted ? "interrupted" : error instanceof Error ? error.message : String(error),
                },
              },
            }).catch(() => {});
            finished = true;
          }
        } finally {
          prompt.close();
          // Closes the query (Claude Code exits; the session is saved). A stalled one is stopped instead.
          if (stalled) abort.abort();
          else await messages.return(undefined).catch(() => {});
          if (current) current.ended = true;
          release();
          if (!finished) {
            await dropSteers();
            await record(spec.threadId, {
              turnId,
              body: { case: "turnFinished", value: { outcome: TurnOutcome.FAILED, providerTurnRef: mapper.lastEntry ?? "", reason: "the session ended without a result" } },
            }).catch(() => {});
          }
        }
      })();
      current = { turnId, query: q, mapper, abort, busCalls, done, prompt, steers, ended: false, interrupting: false };
      active.set(spec.threadId, current);
    };

    return ClaudeThreads.of({
      create: Effect.fn("ClaudeThreads.create")(function* (spec: ThreadSpec, fork?: ForkSpec) {
        const sessionId = fork
          ? yield* Effect.tryPromise({
              try: () =>
                forkSession(fork.sourceProviderThreadId, {
                  dir: spec.cwd,
                  ...(fork.afterProviderTurnRef && { upToMessageId: fork.afterProviderTurnRef }),
                }).then((r) => r.sessionId),
              catch: fail(spec.threadId, "fork"),
            })
          : spec.threadId;
        yield* journal
          .append(spec.threadId, { body: { case: "threadReady", value: { providerThreadId: sessionId } } })
          .pipe(
            Effect.tap((event) => Effect.sync(() => options.publish(event))),
            Effect.mapError(fail(spec.threadId, "journal")),
          );
        return sessionId;
      }),

      startTurn: Effect.fn("ClaudeThreads.startTurn")(function* (spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings) {
        if (started.has(turnId)) return; // redelivered StartTurn
        if (active.has(spec.threadId)) {
          return yield* new ClaudeThreadError({ threadId: spec.threadId, operation: "turn", message: "a turn of this thread is already running" });
        }
        started.add(turnId);
        yield* Effect.tryPromise({ try: () => run(spec, turnId, input, settings), catch: fail(spec.threadId, "turn") }).pipe(
          Effect.tapError(() => Effect.sync(() => started.delete(turnId))),
        );
      }),

      interrupt: Effect.fn("ClaudeThreads.interrupt")(function* (threadId: string, turnId: string) {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.interrupting = true;
        turn.mapper.markInterrupted();
        yield* Effect.tryPromise({ try: () => turn.query.interrupt(), catch: fail(threadId, "interrupt") }).pipe(
          // A query that does not answer the interrupt is aborted.
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.sync(() => turn.abort.abort())),
        );
      }),

      steer: Effect.fn("ClaudeThreads.steer")(function* (threadId: string, turnId: string, inputId: string, input: UserInput) {
        const turn = active.get(threadId);
        if (turn?.turnId === turnId && turn.steers.has(inputId)) return; // redelivered SteerTurn
        if (!turn || turn.turnId !== turnId || turn.ended || turn.interrupting) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn is not running on this worker" });
        }
        // The uuid names the message in command_lifecycle (queued -> started -> completed).
        if (!turn.prompt.push({ type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null, uuid: inputId as SDKUserMessage["uuid"] & string, priority: "next" })) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn's input is closed" });
        }
        turn.steers.set(inputId, { text: input.text, authorUserId: input.authorUserId, started: false });
      }),

      running: (threadId) => active.has(threadId),

      listModels: Effect.fn("ClaudeThreads.listModels")(function* (profileId: string) {
        const profile = options.profile(profileId);
        if (!profile) return yield* new ClaudeThreadError({ threadId: "", operation: "models", message: `provider profile "${profileId || "native"}" is not available` });
        // A query without a prompt starts Claude Code and answers control requests; the model is never called.
        const prompt = new AsyncChannel<SDKUserMessage>();
        const abort = new AbortController();
        const models = yield* Effect.tryPromise({
          try: async () => {
            const q = query({
              prompt,
              options: {
                cwd: options.home,
                ...claudeProfileOptions(profile, { ...options.baseEnv, CLAUDE_CONFIG_DIR: options.home }),
                settingSources: [],
                ...(options.executable && { pathToClaudeCodeExecutable: options.executable }),
                persistSession: false,
                strictMcpConfig: true,
                mcpServers: {},
                abortController: abort,
              },
            });
            try {
              return await Promise.race([
                q.supportedModels(),
                Bun.sleep(30_000).then(() => Promise.reject(new Error("Claude Code did not list its models within 30 s"))),
              ]);
            } finally {
              prompt.close();
              abort.abort();
            }
          },
          catch: fail("", "models"),
        });
        return { models: models.map(claudeModel) };
      }),
    });
  });

/** Tool name and arguments with sorted keys: the MCP handler gets the arguments in schema order. */
function callKey(tool: string, args: unknown): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
        : value;
  return `${tool} ${JSON.stringify(sorted(args))}`;
}

function userItem(turnId: string, itemId: string, clientId: string, text: string, authorUserId: string): ThreadEventInit {
  return {
    turnId,
    body: { case: "itemCompleted", value: { item: { itemId, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text, authorUserId, clientId } } } } },
  };
}
