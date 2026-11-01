import { create } from "@bufbuild/protobuf";
import { forkSession, getSessionMessages, query, type CanUseTool, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import {
  InteractionKind,
  InteractionRequestSchema,
  ItemStatus,
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
import { Context, Effect, Layer, Schema } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import { claudeNativeToolOptions, type NativeToolPolicy } from "../native-tools.ts";
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
    startTurn(spec: ThreadSpec, turnId: string, input: UserInput): Effect.Effect<void, ClaudeThreadError>;
    interrupt(threadId: string, turnId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Whether a turn of this thread runs in this process. */
    running(threadId: string): boolean;
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
}

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

    const run = async (spec: ThreadSpec, turnId: string, input: UserInput) => {
      const profile = options.profile(spec.providerProfileId);
      if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
      const sessionId = spec.providerThreadId || spec.threadId;
      const resume = await sessionExists(sessionId, spec.cwd);
      const permissions = claudePermissions(spec.permissionMode);
      const abort = new AbortController();
      const mapper = new ClaudeEventMapper(turnId);
      const busCalls = new Map<string, string[]>();
      let current: ActiveTurn | undefined;
      const busTools = spec.enableAgentBus ? claudeBusToolNames(spec.depth) : [];
      const queryOptions: Options = {
        cwd: spec.cwd,
        ...(spec.model && { model: spec.model }),
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
      const q = query({ prompt: input.text, options: queryOptions });

      await record(spec.threadId, { turnId, body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND, ...(spec.model && { model: spec.model }) } } });
      await record(spec.threadId, {
        turnId,
        body: { case: "itemCompleted", value: { item: { itemId: `user:${turnId}`, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text: input.text, authorUserId: input.authorUserId } } } } },
      });

      const release = () => {
        if (active.get(spec.threadId) === current) active.delete(spec.threadId);
      };
      const done = (async () => {
        let finished = false;
        try {
          for await (const message of q) {
            if (message.type === "assistant") {
              for (const block of message.message.content) {
                if (block.type !== "tool_use" || !block.name.startsWith(`mcp__${BUS_SERVER}__`)) continue;
                const key = callKey(block.name.slice(`mcp__${BUS_SERVER}__`.length), block.input);
                busCalls.set(key, [...(busCalls.get(key) ?? []), block.id]);
              }
            }
            for (const init of mapper.map(message)) {
              if (init.body?.case === "turnFinished") {
                // Free the thread before the gateway hears the turn is over: it may start the next one at once.
                finished = true;
                release();
              }
              await record(spec.threadId, init);
            }
            // The result ends the turn; leaving the loop closes the query (the session is already saved).
            if (finished) break;
          }
        } catch (error) {
          if (!finished) {
            const interrupted = abort.signal.aborted;
            release();
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
          release();
          if (!finished) {
            await record(spec.threadId, {
              turnId,
              body: { case: "turnFinished", value: { outcome: TurnOutcome.FAILED, providerTurnRef: mapper.lastEntry ?? "", reason: "the session ended without a result" } },
            }).catch(() => {});
          }
        }
      })();
      current = { turnId, query: q, mapper, abort, busCalls, done };
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

      startTurn: Effect.fn("ClaudeThreads.startTurn")(function* (spec: ThreadSpec, turnId: string, input: UserInput) {
        if (started.has(turnId)) return; // redelivered StartTurn
        if (active.has(spec.threadId)) {
          return yield* new ClaudeThreadError({ threadId: spec.threadId, operation: "turn", message: "a turn of this thread is already running" });
        }
        started.add(turnId);
        yield* Effect.tryPromise({ try: () => run(spec, turnId, input), catch: fail(spec.threadId, "turn") }).pipe(
          Effect.tapError(() => Effect.sync(() => started.delete(turnId))),
        );
      }),

      interrupt: Effect.fn("ClaudeThreads.interrupt")(function* (threadId: string, turnId: string) {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.mapper.markInterrupted();
        yield* Effect.tryPromise({ try: () => turn.query.interrupt(), catch: fail(threadId, "interrupt") }).pipe(
          // A query that does not answer the interrupt is aborted.
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.sync(() => turn.abort.abort())),
        );
      }),

      running: (threadId) => active.has(threadId),
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
