import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { forkSession, getSessionMessages, query, type CanUseTool, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  InteractionKind,
  InteractionRequestSchema,
  ItemStatus,
  NoticeLevel,
  TurnEndSource,
  TurnOrigin,
  TurnOutcome,
  type AgentToolCall,
  type AgentToolResult,
  type ForkSpec,
  type InteractionRequest,
  type InteractionResponse,
  type PermissionMode,
  type ThreadEvent,
  type ThreadSpec,
  type UserInput,
} from "@open-agents/contracts";
import { AsyncChannel } from "@open-agents/transport";
import { Context, Effect, Layer, Schema } from "effect";
import { Journal, type ThreadEventInit } from "../../journal/index.ts";
import { claudeAgentModels, claudeModel, isClaudeEffort, proxyCapabilities, type ModelInit, type ProxyCapabilities } from "../models.ts";
import { claudeNativeToolOptions, type NativeToolPolicy } from "../native-tools.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import type { Env, ResolvedProfile } from "../profiles.ts";
import { claudeBusServer, claudeBusToolNames } from "./bus.ts";
import { BUS_SERVER, ClaudeEventMapper, startsTurn, type GoalVerdict } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { claudeProfileOptions } from "./profile.ts";
import { transcriptPath } from "./transcript.ts";
import { reconcileTurn, type EndCause } from "../reconcile.ts";

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
 * - Steered messages go into the same input stream (priority "next": Claude Code takes them in between tool
 *   calls). A steered message that is still queued at the result runs right after it, so the turn goes on
 *   until it has run.
 * - Goals (docs/goals.md): `/goal …` arrives as a turn's input; the evaluator's verdicts are read from the
 *   session transcript after each turn (Claude Code does not stream them to SDK clients).
 * - Every turn notes the session transcript and the offset it starts at (journal turn_harness). A process that ends
 *   mid-turn without a result (it crashed or was killed) settles the turn from the transcript (providers/reconcile.ts):
 *   the end Claude Code recorded, else failed in the harness ("harness process exited"). A turn the worker stops
 *   (shutdown) is interrupted by the system, one the platform interrupts by the user.
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
  /**
   * The device owner's default effort for a model known by these names (their Claude settings, default-effort.ts);
   * read on every use. Platform threads do not load user settings, so a turn without an effort gets this one.
   */
  configuredEffort?(names: readonly string[]): string | undefined;
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
    /** Adds input to the running turn (the input stream); idempotent by inputId. */
    steer(threadId: string, turnId: string, inputId: string, input: UserInput): Effect.Effect<void, SteerError>;
    /** Whether a turn of this thread runs in this process. */
    running(threadId: string): boolean;
    /** Stops a background task (Claude stopTask). */
    stopTask(threadId: string, taskId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Background tasks still running, per platform thread. */
    backgroundTasks(): ReadonlyMap<string, readonly string[]>;
    /** Models a profile offers (Query.supportedModels() without a prompt; no model turn). */
    listModels(profileId: string): Effect.Effect<{ models: ModelInit[] }, ClaudeThreadError>;
  }
>()("open-agents/worker/ClaudeThreads") {
  static readonly layer = (options: ClaudeThreadsOptions) => Layer.effect(ClaudeThreads, make(options));
}

interface Session {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly query: Query;
  /** The input stream: turn inputs and steered messages. */
  readonly input: AsyncChannel<SDKUserMessage>;
  readonly mapper: ClaudeEventMapper;
  readonly abort: AbortController;
  /** Bus tool_use ids by "name args" from streamed assistant messages, for the MCP handler. */
  readonly busCalls: Map<string, string[]>;
  /** Turn in progress (the platform's or one Claude started itself). */
  turn: SessionTurn | undefined;
  /** Model and effort the process runs with (a later turn may switch the model). */
  model: string;
  /** Permission mode the process runs with; canUseTool reads autoAllow per request (a later turn may switch it). */
  mode: PermissionMode;
  autoAllow: boolean;
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

interface SessionTurn {
  readonly turnId: string;
  /** Steered inputs by input id; started once Claude Code took them into the turn (command_lifecycle). */
  readonly steers: Map<string, { readonly text: string; readonly authorUserId: string; started: boolean }>;
  /** The turn is finishing (result seen, or interrupted): no more steers. */
  ended: boolean;
  interrupting: boolean;
}

/** How long a turn waits after a result for a steered message Claude Code has not taken yet. */
const STEER_GRACE_MS = 60_000;

const userMessage = (text: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage =>
  ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...extra }) as SDKUserMessage;

const make = (options: ClaudeThreadsOptions) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const sessions = new Map<string, Session>();
    /** Turns started in this process, so a redelivered StartTurn does not run twice. */
    const started = new Set<string>();
    /** Model id → the model it resolves to (aliases, "default"), from the last listing. */
    const resolvedModels = new Map<string, string>();
    /** Model id → its effort levels, from the last listing (empty = the model has no effort setting). */
    const modelEfforts = new Map<string, readonly string[]>();
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
          session.input.close();
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
      (spec: ThreadSpec, turnId: () => string, autoAllow: () => boolean): CanUseTool =>
      async (toolName, input, context) => {
        if (toolName.startsWith(`mcp__${BUS_SERVER}__`) && context.mcpServer?.source === "sdk") return { behavior: "allow", updatedInput: input };
        const question = toolName === "AskUserQuestion";
        if (autoAllow() && !question) return { behavior: "allow", updatedInput: input };
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
      session.turn = { turnId, steers: new Map(), ended: false, interrupting: false };
      session.mapper.beginTurn(turnId);
      // Where Claude Code records this turn: everything after the transcript's current end.
      const transcript = transcriptPath(options.home, session.sessionId);
      await Effect.runPromise(
        journal
          .noteHarness(session.threadId, turnId, { harness: "claude", transcript: options.home, sessionId: session.sessionId, offset: transcript ? fileSize(transcript) : 0, providerTurn: "" })
          .pipe(Effect.ignore),
      );
      await record(session.threadId, { turnId, body: { case: "turnStarted", value: { origin, ...(model && { model }) } } });
    };

    /** An idle process ends unless background tasks run; after tasks it waits a little for a turn Claude starts. */
    const closeWhenIdle = (session: Session) => {
      if (session.turn || session.closing || session.mapper.backgroundTasks.length > 0 || session.closeTimer) return;
      const close = () => {
        session.closeTimer = undefined;
        if (session.turn || session.mapper.backgroundTasks.length > 0) return;
        session.closing = true;
        session.input.close();
      };
      if (session.hadTasks) session.closeTimer = setTimeout(close, idleGraceMs);
      else close();
    };

    const open = async (spec: ThreadSpec, model: string, effort: Options["effort"], mode: PermissionMode): Promise<Session> => {
      const profile = options.profile(spec.providerProfileId);
      if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
      const sessionId = spec.providerThreadId || spec.threadId;
      const resume = await sessionExists(sessionId, spec.cwd);
      const permissions = claudePermissions(mode);
      const input = new AsyncChannel<SDKUserMessage>();
      const abort = new AbortController();
      const busCalls = new Map<string, string[]>();
      let session: Session | undefined;
      const turnId = () => session?.turn?.turnId ?? "";
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
        canUseTool: canUseTool(spec, turnId, () => session?.autoAllow ?? false),
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
        model,
        mode,
        autoAllow: permissions.autoAllow,
        outputs: new Map(),
        // Verdicts of earlier turns are already recorded: read only what this process adds.
        transcript: { path: transcript, offset: transcript ? fileSize(transcript) : 0, tail: "" },
        io: Promise.resolve(),
        hadTasks: false,
        closing: false,
        closeTimer: undefined,
        done: Promise.resolve(),
      };
      session.done = consume(session);
      sessions.set(spec.threadId, session);
      return session;
    };

    /**
     * A live process (kept by background tasks) takes the next turn's mode before the turn starts: Claude Code's
     * permission mode, the sandbox (the flag settings layer, where Options.sandbox lives) and auto-allow in
     * canUseTool. Nothing of the previous turn waits for a decision any more (no turn runs).
     */
    const switchMode = async (session: Session, mode: PermissionMode) => {
      const current = claudePermissions(session.mode);
      const next = claudePermissions(mode);
      // Leaving FULL_AUTO: stop auto-allowing first; entering it: only once the sandbox is on.
      if (!next.autoAllow) session.autoAllow = false;
      if (Boolean(next.options.sandbox) !== Boolean(current.options.sandbox)) {
        // Options.sandbox and the settings' sandbox are the same object (the SDK merges the option into this layer).
        type FlagSandbox = NonNullable<Parameters<Query["applyFlagSettings"]>[0]["sandbox"]>;
        const sandbox = (next.options.sandbox ?? null) as FlagSandbox | null;
        await session.query.applyFlagSettings({ sandbox });
      }
      await session.query.setPermissionMode(next.options.permissionMode ?? "default");
      session.mode = mode;
      session.autoAllow = next.autoAllow;
    };

    /** Steered messages that never joined their turn: the gateway queues them as the next turn. */
    const dropSteers = async (session: Session, turn: SessionTurn) => {
      for (const [inputId, steer] of turn.steers) {
        if (steer.started) continue;
        turn.steers.delete(inputId);
        await record(session.threadId, {
          turnId: turn.turnId,
          body: {
            case: "notice",
            value: { level: NoticeLevel.WARNING, code: "steer_dropped", message: "the message did not join the turn before it ended", dataJson: JSON.stringify({ input_id: inputId }) },
          },
        }).catch(() => {});
      }
    };

    /** Reads the process's messages until it ends: turns (also the ones Claude starts), steers, background tasks, goals. */
    const consume = async (session: Session) => {
      const { mapper, threadId } = session;
      /** Ends the current turn: free the thread before the gateway hears it is over (it may start the next one). */
      const endTurn = async () => {
        const turn = session.turn;
        session.turn = undefined;
        if (!turn) return;
        turn.ended = true;
        await dropSteers(session, turn);
      };
      const finishTurn = async (cause: EndCause) => {
        const turn = session.turn;
        if (!turn) return;
        await endTurn();
        await record(threadId, {
          turnId: turn.turnId,
          body: {
            case: "turnFinished",
            value: { outcome: cause.outcome, source: cause.source, reason: cause.reason, ...(cause.errorCode && { errorCode: cause.errorCode }), providerTurnRef: mapper.lastEntry ?? "" },
          },
        }).catch(() => {});
      };
      /**
       * The process ended mid-turn on its own: the transcript says how far it got (items it never streamed, its end);
       * without an end there the turn failed in the harness.
       */
      const settleFromTranscript = async (cause: EndCause) => {
        const turn = session.turn;
        if (!turn) return;
        await endTurn();
        await session.io;
        try {
          const open = (await Effect.runPromise(journal.openTurns())).find((t) => t.threadId === threadId && t.turnId === turn.turnId);
          if (!open) return;
          const { events } = await Effect.runPromise(reconcileTurn(open, cause).pipe(Effect.provideService(Journal, journal)));
          for (const event of events) options.publish(event);
        } catch {
          await record(threadId, { turnId: turn.turnId, body: { case: "turnFinished", value: { outcome: cause.outcome, source: cause.source, reason: cause.reason, errorCode: cause.errorCode ?? "" } } }).catch(() => {});
        }
      };
      /** Why the process ended mid-turn: the worker stopping it, the platform interrupting, or the process itself. */
      const knownEnd = (): EndCause | undefined => {
        if (shuttingDown) return { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker stopped mid-turn" };
        if (session.turn?.interrupting || session.abort.signal.aborted) return { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" };
        return undefined;
      };
      /** A result that did not end the turn (a steered message was still queued): ends it if nothing follows. */
      let deferredResult: ThreadEventInit | undefined;
      const messages = session.query[Symbol.asyncIterator]();
      try {
        for (;;) {
          // After a deferred result the steered message must start soon; otherwise that result ends the turn.
          const next = deferredResult ? await Promise.race([messages.next(), Bun.sleep(STEER_GRACE_MS).then(() => undefined)]) : await messages.next();
          if (!next && deferredResult) {
            const result = deferredResult;
            deferredResult = undefined;
            await endTurn();
            await record(threadId, result);
            closeWhenIdle(session);
            continue;
          }
          if (!next || next.done) break;
          const message = next.value;
          if (deferredResult && session.turn) mapper.continueTurn(session.turn.turnId);
          deferredResult = undefined;
          const lifecycle = message as unknown as { type: string; command_uuid?: string; state?: string };
          const steer = lifecycle.type === "command_lifecycle" && lifecycle.state === "started" && lifecycle.command_uuid ? session.turn?.steers.get(lifecycle.command_uuid) : undefined;
          if (steer && !steer.started && session.turn) {
            steer.started = true;
            await record(threadId, userItem(session.turn.turnId, `user:${lifecycle.command_uuid}`, lifecycle.command_uuid ?? "", steer.text, steer.authorUserId));
          }
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type !== "tool_use" || !block.name.startsWith(`mcp__${BUS_SERVER}__`)) continue;
              const key = callKey(block.name.slice(`mcp__${BUS_SERVER}__`.length), block.input);
              session.busCalls.set(key, [...(session.busCalls.get(key) ?? []), block.id]);
            }
          }
          // Claude starts a turn by itself (e.g. to report a finished background task): a provider turn.
          if (!session.turn && startsTurn(message)) await beginTurn(session, Bun.randomUUIDv7(), TurnOrigin.PROVIDER, session.model);
          // The task's last output lands before its end.
          if (message.type === "system" && message.subtype === "task_notification") await readOutput(session, message.task_id, message.output_file);
          // The evaluator's verdict of this turn belongs to it.
          if (message.type === "result") await readGoalVerdicts(session);
          for (const init of mapper.map(message)) {
            if (init.body?.case === "turnFinished") {
              const turn = session.turn;
              // A steered message still queued in Claude Code runs right after this result: the turn goes on
              // (the result is kept, without its body). An interrupt drops such messages instead.
              if (turn && !turn.interrupting && [...turn.steers.values()].some((s) => !s.started)) {
                deferredResult = init;
                await record(threadId, { turnId: turn.turnId, rawJson: init.rawJson ?? "" });
                continue;
              }
              await endTurn();
            }
            if (init.body?.case === "itemStarted" && init.body.value.item?.content?.case === "backgroundTask") session.hadTasks = true;
            await record(threadId, init);
          }
          if (!deferredResult) closeWhenIdle(session);
        }
        if (deferredResult) {
          await endTurn();
          await record(threadId, deferredResult);
        }
        if (session.turn) {
          const known = knownEnd();
          if (known) await finishTurn(known);
          else await settleFromTranscript({ outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason: "harness process exited: the session ended without a result", errorCode: "process_exit" });
        }
      } catch (error) {
        const known = knownEnd();
        if (known) await finishTurn(known);
        else await settleFromTranscript({ outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason: `harness process exited: ${error instanceof Error ? error.message : String(error)}`, errorCode: "process_exit" });
      } finally {
        session.input.close();
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

      startTurn: Effect.fn("ClaudeThreads.startTurn")(function* (spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings) {
        if (started.has(turnId)) return; // redelivered StartTurn
        const model = settings?.model || spec.model;
        const mode = settings?.permissionMode || spec.permissionMode;
        const requested = settings?.effort ?? "";
        if (requested && !isClaudeEffort(requested)) {
          return yield* new ClaudeThreadError({ threadId: spec.threadId, operation: "turn", message: `unknown reasoning effort "${requested}" (Claude: low, medium, high, xhigh, max)` });
        }
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
            if (session && session.mode !== mode && session.mapper.backgroundTasks.length === 0) {
              // Only the grace period after tasks keeps it: a new process starts with the turn's mode.
              if (session.closeTimer) clearTimeout(session.closeTimer);
              session.closeTimer = undefined;
              session.closing = true;
              session.input.close();
              await session.done;
              session = undefined;
            }
            if (!session) {
              // No effort chosen: the device owner's configured default (docs/claude-adapter.md).
              const configured = requested ? undefined : options.configuredEffort?.([model || "default", resolvedModels.get(model || "default") ?? ""]);
              // Only a level the model offers: a model without efforts gets none (docs/protocol.md, "Wysiłek a model").
              const offered = modelEfforts.get(model || "default");
              const fits = configured && isClaudeEffort(configured) && (!offered || offered.includes(configured));
              const effort = isClaudeEffort(requested) ? requested : fits ? configured : undefined;
              session = await open(spec, model, effort, mode);
            } else {
              // A process kept alive by background tasks: the turn's model and mode apply from now on.
              if (model && model !== session.model) {
                await session.query.setModel(model);
                session.model = model;
              }
              if (mode !== session.mode) await switchMode(session, mode);
            }
            await beginTurn(session, turnId, TurnOrigin.COMMAND, model);
            await record(spec.threadId, userItem(turnId, `user:${turnId}`, turnId, input.text, input.authorUserId));
            session.input.push(userMessage(input.text));
          },
          catch: fail(spec.threadId, "turn"),
        }).pipe(Effect.tapError(() => Effect.sync(() => started.delete(turnId))));
      }),

      interrupt: Effect.fn("ClaudeThreads.interrupt")(function* (threadId: string, turnId: string) {
        const session = sessions.get(threadId);
        if (!session?.turn || (turnId && session.turn.turnId !== turnId)) return;
        session.turn.interrupting = true;
        session.mapper.markInterrupted();
        yield* Effect.tryPromise({ try: () => session.query.interrupt(), catch: fail(threadId, "interrupt") }).pipe(
          // A query that does not answer the interrupt is aborted.
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.sync(() => session.abort.abort())),
        );
      }),

      steer: Effect.fn("ClaudeThreads.steer")(function* (threadId: string, turnId: string, inputId: string, input: UserInput) {
        const session = sessions.get(threadId);
        const turn = session?.turn;
        if (turn?.turnId === turnId && turn.steers.has(inputId)) return; // redelivered SteerTurn
        if (!session || !turn || turn.turnId !== turnId || turn.ended || turn.interrupting) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn is not running on this worker" });
        }
        // The uuid names the message in command_lifecycle (queued -> started -> completed).
        if (!session.input.push(userMessage(input.text, { uuid: inputId as SDKUserMessage["uuid"] & string, priority: "next" }))) {
          return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn's input is closed" });
        }
        turn.steers.set(inputId, { text: input.text, authorUserId: input.authorUserId, started: false });
      }),

      running: (threadId) => sessions.get(threadId)?.turn !== undefined,

      stopTask: Effect.fn("ClaudeThreads.stopTask")(function* (threadId: string, taskId: string) {
        const session = sessions.get(threadId);
        if (!session?.mapper.markStopping(taskId)) return yield* new ClaudeThreadError({ threadId, operation: "stop", message: "the task is not running here" });
        yield* Effect.tryPromise({ try: () => session.query.stopTask(taskId), catch: fail(threadId, "stop") });
      }),

      backgroundTasks: () =>
        new Map([...sessions.values()].flatMap((s) => (s.mapper.backgroundTasks.length > 0 ? [[s.threadId, s.mapper.backgroundTasks] as const] : []))),

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
        // Through a proxy: its capabilities say which listed models cannot run an agent turn (optional).
        const capabilities =
          profile.kind === "cliproxyapi" ? yield* Effect.tryPromise(() => proxyCapabilities(profile)).pipe(Effect.orElseSucceed((): ProxyCapabilities[] => [])) : [];
        const agentModels = claudeAgentModels(models, capabilities);
        for (const m of agentModels) {
          if (m.resolvedModel) resolvedModels.set(m.value, m.resolvedModel);
          modelEfforts.set(m.value, m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []));
        }
        return { models: agentModels.map((m) => claudeModel(m, options.configuredEffort?.([m.value, m.resolvedModel ?? ""]))) };
      }),
    });
  });


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

function userItem(turnId: string, itemId: string, clientId: string, text: string, authorUserId: string): ThreadEventInit {
  return {
    turnId,
    body: { case: "itemCompleted", value: { item: { itemId, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text, authorUserId, clientId } } } } },
  };
}
