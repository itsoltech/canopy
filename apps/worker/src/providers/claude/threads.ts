import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { forkSession, getSessionMessages, query, type CanUseTool, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
import { BUS_SERVER, ClaudeEventMapper, startsTurn, type GoalVerdict } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { claudeProfileOptions } from "./profile.ts";

/**
 * Platform threads on Claude Code through the Agent SDK (docs/claude-adapter.md).
 *
 * - A thread is a Claude session. Its id is chosen by the platform (the thread id), so thread_ready
 *   is recorded at creation without calling the model; a fork copies the source session up to the
 *   fork point (forkSession) and gets a new session id.
 * - A turn runs in a Claude Code process with open input (streaming input mode): a new session with
 *   sessionId on the first turn, resume afterwards. The process ends with the turn unless background tasks
 *   run (docs/execution.md): then it stays, their output is read from their output files, and when one ends
 *   Claude may start a turn by itself (a provider turn). A StartTurn meanwhile goes into the same process.
 *   Events go to the journal first, then to the gateway (publish), in order.
 * - Goals (docs/goals.md): `/goal …` arrives as a turn's input; the evaluator's verdicts are read from the
 *   session transcript after each turn (Claude Code does not stream them to SDK clients).
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
  /** How long an idle process that had background tasks waits for a turn Claude starts itself (default 3 s). */
  readonly idleGraceMs?: number;
  /** How often background task output files are read (default 1 s). */
  readonly outputPollMs?: number;
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
    /** Stops a background task (Claude stopTask). */
    stopTask(threadId: string, taskId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Background tasks still running, per platform thread. */
    backgroundTasks(): ReadonlyMap<string, readonly string[]>;
  }
>()("open-agents/worker/ClaudeThreads") {
  static readonly layer = (options: ClaudeThreadsOptions) => Layer.effect(ClaudeThreads, make(options));
}

interface Session {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly query: Query;
  readonly input: InputQueue;
  readonly mapper: ClaudeEventMapper;
  readonly abort: AbortController;
  /** Bus tool_use ids by "name args" from streamed assistant messages, for the MCP handler. */
  readonly busCalls: Map<string, string[]>;
  /** Turn in progress (the platform's or one Claude started itself). */
  turn: { readonly turnId: string } | undefined;
  /** Read position in each background task's output file. */
  readonly outputs: Map<string, { offset: number; readonly decoder: TextDecoder }>;
  /** Read position in the session transcript (goal verdicts). */
  transcript: { path: string | undefined; offset: number; tail: string };
  /** File reads and the events they produce, one at a time. */
  io: Promise<void>;
  hadTasks: boolean;
  closing: boolean;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  done: Promise<void>;
}

/** Input stream of a Claude Code process: user messages until end(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #queued: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(text: string): void {
    this.#queued.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

const make = (options: ClaudeThreadsOptions) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const sessions = new Map<string, Session>();
    /** Turns started in this process, so a redelivered StartTurn does not run twice. */
    const started = new Set<string>();
    let shuttingDown = false;
    const idleGraceMs = options.idleGraceMs ?? 3_000;
    // Session helpers (forkSession, getSessionMessages) run in this process and read CLAUDE_CONFIG_DIR here.
    process.env["CLAUDE_CONFIG_DIR"] = options.home;

    const fail = (threadId: string, operation: string) => (error: unknown) =>
      new ClaudeThreadError({ threadId, operation, message: error instanceof Error ? error.message : String(error) });

    const record = (threadId: string, init: ThreadEventInit) =>
      Effect.runPromise(journal.append(threadId, init).pipe(Effect.tap((event) => Effect.sync(() => options.publish(event)))));

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        shuttingDown = true;
        for (const session of sessions.values()) {
          session.input.end();
          session.abort.abort();
        }
        await Promise.allSettled([...sessions.values()].map((s) => s.done));
      }),
    );

    // Background task output, read from the files Claude Code writes it to.
    const poll = setInterval(() => {
      for (const session of sessions.values()) for (const taskId of session.mapper.backgroundTasks) void readOutput(session, taskId);
    }, options.outputPollMs ?? 1_000);
    yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(poll)));

    const serial = (session: Session, run: () => Promise<void>) => {
      const next = session.io.then(run, run).catch(() => {});
      session.io = next;
      return next;
    };

    const readOutput = (session: Session, taskId: string, file?: string) =>
      serial(session, async () => {
        const path = file ?? session.mapper.outputFile(taskId);
        if (!path || !existsSync(path)) return;
        const state = session.outputs.get(taskId) ?? { offset: 0, decoder: new TextDecoder() };
        session.outputs.set(taskId, state);
        const chunk = readFrom(path, state.offset);
        if (chunk.length === 0) return;
        state.offset += chunk.length;
        for (const init of session.mapper.taskOutput(taskId, state.decoder.decode(chunk, { stream: true }))) await record(session.threadId, init);
      });

    /** Goal verdicts the evaluator wrote to the session transcript since the last read. */
    const readGoalVerdicts = (session: Session) =>
      serial(session, async () => {
        const transcript = session.transcript;
        transcript.path ??= transcriptPath(options.home, session.sessionId);
        if (!transcript.path) return;
        const chunk = readFrom(transcript.path, transcript.offset);
        transcript.offset += chunk.length;
        const lines = (transcript.tail + new TextDecoder().decode(chunk)).split("\n");
        transcript.tail = lines.pop() ?? "";
        for (const line of lines) {
          const verdict = goalVerdictOf(line);
          if (verdict) for (const init of session.mapper.goalVerdict(verdict)) await record(session.threadId, init);
        }
      });

    const sessionExists = async (sessionId: string, cwd: string) => {
      try {
        return (await getSessionMessages(sessionId, { dir: cwd })).length > 0;
      } catch {
        return false;
      }
    };

    const canUseTool =
      (spec: ThreadSpec, turnId: () => string, autoAllow: boolean): CanUseTool =>
      async (toolName, input, context) => {
        if (toolName.startsWith(`mcp__${BUS_SERVER}__`) && context.mcpServer?.source === "sdk") return { behavior: "allow", updatedInput: input };
        const question = toolName === "AskUserQuestion";
        if (autoAllow && !question) return { behavior: "allow", updatedInput: input };
        const answer = await options.interact(
          create(InteractionRequestSchema, {
            requestId: Bun.randomUUIDv7(),
            threadId: spec.threadId,
            turnId: turnId(),
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

    const beginTurn = async (session: Session, turnId: string, origin: TurnOrigin, model: string) => {
      if (session.closeTimer) clearTimeout(session.closeTimer);
      session.closeTimer = undefined;
      session.turn = { turnId };
      session.mapper.beginTurn(turnId);
      await record(session.threadId, { turnId, body: { case: "turnStarted", value: { origin, ...(model && { model }) } } });
    };

    /** An idle process ends unless background tasks run; after tasks it waits a little for a turn Claude starts. */
    const closeWhenIdle = (session: Session) => {
      if (session.turn || session.closing || session.mapper.backgroundTasks.length > 0 || session.closeTimer) return;
      const close = () => {
        session.closeTimer = undefined;
        if (session.turn || session.mapper.backgroundTasks.length > 0) return;
        session.closing = true;
        session.input.end();
      };
      if (session.hadTasks) session.closeTimer = setTimeout(close, idleGraceMs);
      else close();
    };

    const open = async (spec: ThreadSpec): Promise<Session> => {
      const profile = options.profile(spec.providerProfileId);
      if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
      const sessionId = spec.providerThreadId || spec.threadId;
      const resume = await sessionExists(sessionId, spec.cwd);
      const permissions = claudePermissions(spec.permissionMode);
      const input = new InputQueue();
      const abort = new AbortController();
      const busCalls = new Map<string, string[]>();
      let session: Session | undefined;
      const turnId = () => session?.turn?.turnId ?? "";
      const busTools = spec.enableAgentBus ? claudeBusToolNames(spec.depth) : [];
      const queryOptions: Options = {
        cwd: spec.cwd,
        ...(spec.model && { model: spec.model }),
        ...claudeProfileOptions(profile, { ...options.baseEnv, CLAUDE_CONFIG_DIR: options.home }),
        ...(options.executable && { pathToClaudeCodeExecutable: options.executable }),
        ...(resume ? { resume: sessionId } : { sessionId }),
        includePartialMessages: true,
        ...permissions.options,
        canUseTool: canUseTool(spec, turnId, permissions.autoAllow),
        // Bus tools pass every mode (dontAsk denies whatever is not pre-approved).
        allowedTools: busTools,
        ...claudeNativeToolOptions(options.nativeTools),
        // The platform stops background tasks one by one (StopTask): an interrupt spares them.
        perTaskStopAffordance: true,
        // Only the platform's MCP servers: the device owner's would leak their tools and accounts.
        strictMcpConfig: true,
        mcpServers: spec.enableAgentBus
          ? {
              [BUS_SERVER]: claudeBusServer({
                threadId: spec.threadId,
                depth: spec.depth,
                turnId,
                toolUseId: (tool, args) => busCalls.get(callKey(tool, args))?.shift(),
                callTool: options.callTool,
              }),
            }
          : {},
        systemPrompt: { type: "preset", preset: "claude_code", ...(spec.instructions && { append: spec.instructions }) },
        abortController: abort,
      };
      const q = query({ prompt: input, options: queryOptions });
      const transcript = transcriptPath(options.home, sessionId);
      session = {
        threadId: spec.threadId,
        sessionId,
        cwd: spec.cwd,
        query: q,
        input,
        mapper: new ClaudeEventMapper(),
        abort,
        busCalls,
        turn: undefined,
        outputs: new Map(),
        // Verdicts of earlier turns are already recorded: read only what this process adds.
        transcript: { path: transcript, offset: transcript ? fileSize(transcript) : 0, tail: "" },
        io: Promise.resolve(),
        hadTasks: false,
        closing: false,
        closeTimer: undefined,
        done: Promise.resolve(),
      };
      session.done = consume(session, spec.model);
      sessions.set(spec.threadId, session);
      return session;
    };

    /** Reads the process's messages until it ends: turns (also the ones Claude starts), background tasks, goals. */
    const consume = async (session: Session, model: string) => {
      const { mapper, threadId } = session;
      const finishTurn = async (outcome: TurnOutcome, reason: string) => {
        const turn = session.turn;
        if (!turn) return;
        session.turn = undefined;
        await record(threadId, { turnId: turn.turnId, body: { case: "turnFinished", value: { outcome, providerTurnRef: mapper.lastEntry ?? "", reason } } }).catch(() => {});
      };
      try {
        for await (const message of session.query) {
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type !== "tool_use" || !block.name.startsWith(`mcp__${BUS_SERVER}__`)) continue;
              const key = callKey(block.name.slice(`mcp__${BUS_SERVER}__`.length), block.input);
              session.busCalls.set(key, [...(session.busCalls.get(key) ?? []), block.id]);
            }
          }
          // Claude starts a turn by itself (e.g. to report a finished background task): a provider turn.
          if (!session.turn && startsTurn(message)) await beginTurn(session, Bun.randomUUIDv7(), TurnOrigin.PROVIDER, model);
          // The task's last output lands before its end.
          if (message.type === "system" && message.subtype === "task_notification") await readOutput(session, message.task_id, message.output_file);
          // The evaluator's verdict of this turn belongs to it.
          if (message.type === "result") await readGoalVerdicts(session);
          for (const init of mapper.map(message)) {
            // Free the thread before the gateway hears the turn is over: it may start the next one at once.
            if (init.body?.case === "turnFinished") session.turn = undefined;
            if (init.body?.case === "itemStarted" && init.body.value.item?.content?.case === "backgroundTask") session.hadTasks = true;
            await record(threadId, init);
          }
          closeWhenIdle(session);
        }
        await finishTurn(TurnOutcome.FAILED, "the session ended without a result");
      } catch (error) {
        const interrupted = session.abort.signal.aborted;
        await finishTurn(interrupted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED, interrupted ? "interrupted" : error instanceof Error ? error.message : String(error));
      } finally {
        if (session.closeTimer) clearTimeout(session.closeTimer);
        await session.io;
        // Tasks die with the process.
        for (const init of mapper.endTasks(shuttingDown ? "worker_restart" : "error")) await record(threadId, init).catch(() => {});
        await readGoalVerdicts(session);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      }
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
        started.add(turnId);
        yield* Effect.tryPromise({
          try: async () => {
            let session = sessions.get(spec.threadId);
            // A process that is ending (idle, no tasks) finishes first; the turn gets a new one.
            if (session?.closing) {
              await session.done;
              session = undefined;
            }
            if (session?.turn) throw new Error("a turn of this thread is already running");
            session ??= await open(spec);
            await beginTurn(session, turnId, TurnOrigin.COMMAND, spec.model);
            await record(spec.threadId, {
              turnId,
              body: {
                case: "itemCompleted",
                value: { item: { itemId: `user:${turnId}`, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text: input.text, authorUserId: input.authorUserId } } } },
              },
            });
            session.input.push(input.text);
          },
          catch: fail(spec.threadId, "turn"),
        }).pipe(Effect.tapError(() => Effect.sync(() => started.delete(turnId))));
      }),

      interrupt: Effect.fn("ClaudeThreads.interrupt")(function* (threadId: string, turnId: string) {
        const session = sessions.get(threadId);
        if (!session?.turn || (turnId && session.turn.turnId !== turnId)) return;
        session.mapper.markInterrupted();
        yield* Effect.tryPromise({ try: () => session.query.interrupt(), catch: fail(threadId, "interrupt") }).pipe(
          // A query that does not answer the interrupt is aborted.
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.sync(() => session.abort.abort())),
        );
      }),

      running: (threadId) => sessions.get(threadId)?.turn !== undefined,

      stopTask: Effect.fn("ClaudeThreads.stopTask")(function* (threadId: string, taskId: string) {
        const session = sessions.get(threadId);
        if (!session?.mapper.markStopping(taskId)) return yield* new ClaudeThreadError({ threadId, operation: "stop", message: "the task is not running here" });
        yield* Effect.tryPromise({ try: () => session.query.stopTask(taskId), catch: fail(threadId, "stop") });
      }),

      backgroundTasks: () =>
        new Map([...sessions.values()].flatMap((s) => (s.mapper.backgroundTasks.length > 0 ? [[s.threadId, s.mapper.backgroundTasks] as const] : []))),
    });
  });

/** Session transcript of Claude Code: <config dir>/projects/<project dir>/<session id>.jsonl. */
function transcriptPath(home: string, sessionId: string): string | undefined {
  const projects = join(home, "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** A goal_status attachment line of the transcript (the /goal evaluator's verdict). */
export function goalVerdictOf(line: string): GoalVerdict | undefined {
  if (!line.includes('"goal_status"')) return undefined;
  try {
    const entry = JSON.parse(line) as { type?: string; attachment?: { type?: string } & Partial<GoalVerdict> };
    const a = entry.attachment;
    if (entry.type !== "attachment" || a?.type !== "goal_status" || typeof a.condition !== "string") return undefined;
    return {
      met: a.met === true,
      condition: a.condition,
      ...(a.failed && { failed: true }),
      ...(a.sentinel && { sentinel: true }),
      ...(typeof a.reason === "string" && { reason: a.reason }),
      ...(typeof a.iterations === "number" && { iterations: a.iterations }),
    };
  } catch {
    return undefined;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes of a file from an offset (empty when it is missing or has not grown). */
function readFrom(path: string, offset: number): Uint8Array {
  const size = fileSize(path);
  if (size <= offset) return new Uint8Array(0);
  const buffer = new Uint8Array(Math.min(size - offset, 1 << 20));
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

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
