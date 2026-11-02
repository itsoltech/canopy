import { create, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import {
  CommandResultSchema,
  CommandSchema,
  ForkSpecSchema,
  GoalDirective,
  InteractionResponseSchema,
  MentionCatalogSchema,
  MentionKind,
  MentionSchema,
  type Mention,
  type MentionCatalog,
  ItemStatus,
  PermissionMode,
  Provider,
  ui,
  type Command,
  type CommandResult,
  type BlobChunk,
  type FetchBlob,
  type ProfileModels,
  type ThreadEvent,
} from "@open-agents/contracts";
import { Effect, type ManagedRuntime } from "effect";
import { createWorkerLink, type CommandInit, type WorkerConnection, type WorkerLink } from "../worker-link/index.ts";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  attachmentPath,
  attachmentsNote,
  claudeGoalCommand,
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_BUS_LIMITS,
  formatSize,
  checkMentions,
  composeMessage,
  fuzzyRank,
  isFinished,
  MentionError,
  storedSidebarWidth,
  withAttachmentsNote,
  type AttachmentLimits,
} from "@open-agents/domain";
import { AttachmentRejected, prepareAttachment, sha256Hex } from "../attachments/prepare.ts";
import { isPlatformCommand, mentionsFromJson, mentionsToJson, PLATFORM_COMMANDS, workerPath } from "./mentions.ts";
import { AttachmentStore, toUiAttachment, type StoredAttachment } from "../store/attachments.ts";
import {
  AgentBusStore,
  applyInstanceModels,
  harnessOf,
  GatewayStore,
  GoalStore,
  Ingest,
  NotFound,
  ModelStore,
  modelProblem,
  permissionModeName,
  permissionModeOf,
  InstanceStore,
  withCustomModels,
  SettingsStore,
  SteerStore,
  toUiGoal,
  toUiSchedule,
  toUiSteer,
  toUiThread,
  toUiTurn,
  turnEffort,
  type GoalRow,
  type ScheduleRow,
  type ThreadRow,
  type TurnRow,
} from "../store/index.ts";
import { cronProblem, nextCronRun } from "./cron.ts";
import { AgentBus } from "./agent-bus.ts";
import { Hub } from "./hub.ts";
import { Scheduler } from "./scheduler.ts";

/**
 * The gateway's runtime state machine (docs/ui-api.md, docs/durability.md):
 * - workers: connect, outbox redelivery, transcript ingest + ack after commit, config, interactions,
 * - scheduler: one running turn per thread; a turn starts only once the thread is ready,
 * - command results: failed thread creation / turn start / goal command become visible state, not silent drops,
 * - worker restarts: turns the worker no longer runs (Hello.running_turns, an interrupt it cannot carry out) end here,
 * - turn ends: whatever the worker reported, nothing of a finished turn stays open (settle), and a sweep finds and
 *   fixes what still is (at start and periodically; docs/durability.md, "Stany tury i wątku"),
 * - agent bus: tool calls from agents (side threads, messages, waits), notifications, questions to parents,
 * - models and steering: workers' model catalogs, per-turn model and effort, messages into a running turn,
 * - UI operations and live fan-out through the hub.
 */

export type CoreRuntime = ManagedRuntime.ManagedRuntime<
  GatewayStore | Ingest | AgentBusStore | SettingsStore | ModelStore | SteerStore | GoalStore | InstanceStore | AttachmentStore,
  unknown
>;

export interface GatewayCoreOptions {
  readonly runtime: CoreRuntime;
  readonly instanceId: string;
  /** Single development user until authentication lands (docs/ui-api.md). */
  readonly userId: string;
  readonly log?: (message: string) => void;
  readonly commandTimeoutMs?: number;
  /** Per file, per message and how many files (docs/ui-api.md, "Załączniki"); defaults: DEFAULT_ATTACHMENT_LIMITS. */
  readonly attachmentLimits?: AttachmentLimits;
}

/** Bytes per BlobChunk on the worker link (attachments down, previews up). */
const BLOB_CHUNK_BYTES = 256 * 1024;
/** Largest preview a worker may upload (it scales images to at most 2000 px). */
const MAX_PREVIEW_BYTES = 8 * 1024 ** 2;
const PREVIEW_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type TurnInputJson = TurnRow["input"];

/** How long the gateway reuses a worker's mention catalog (refresh skips it; the worker keeps its own). */
const CATALOG_TTL_MS = 30_000;

/** Where a model is chosen: an existing thread, or a new one (workspace, provider, profile). */
type ModelScope = { thread: ThreadRow } | { workspaceId: string; provider: Provider; profileId: string };

// A steer waits as long as a turn would: a worker that is back too late answers "not running" and it is queued.
const TTL = { createThread: 24 * 3600, startTurn: 24 * 3600, interruptTurn: 60, steerTurn: 24 * 3600, setGoal: 3600, stopTask: 300 } as const;

/** Why the gateway ended a turn its worker no longer runs (turns.interrupt_reason). */
const WORKER_RESTARTED = "worker restarted";

/** Audit reasons of items the gateway closes (thread_events.raw of its item_completed). */
const SETTLE_TURN_ENDED = "the turn ended while the item was still open";
const SETTLE_SWEEP = "sweep: the item's turn is over";
/** The sweep treats a thread as running without a turn only after this long (a turn_started may be on its way). */
const SWEEP_STALE_SECONDS = 60;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Worker error codes that mean the harness refused or failed (worker runtime/host.ts); the rest are ours. */
const HARNESS_ERROR_CODES: ReadonlySet<string> = new Set(["HARNESS_ERROR"]);

/** Claude's goal condition limit (Claude Code rejects longer ones). */
const MAX_OBJECTIVE = 4000;

export class GatewayCore {
  readonly link: WorkerLink;
  readonly hub = new Hub();
  readonly bus: AgentBus;
  readonly scheduler: Scheduler;
  readonly #options: GatewayCoreOptions;
  readonly #journalIds = new Map<string, string>();
  /** Threads whose events failed to store on a connection: skipped until the worker reconnects and resends. */
  readonly #blocked = new WeakMap<WorkerConnection, Set<string>>();
  /** Mention catalogs by worker + provider + profile + folder (the composer asks on every popup). */
  readonly #catalogs = new Map<string, { at: number; catalog: MentionCatalog }>();
  /** Previews a worker is uploading (BlobChunk), by sha256, until their last chunk. */
  readonly #uploads = new WeakMap<WorkerConnection, Map<string, { chunks: Uint8Array[]; size: number; mimeType: string }>>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: GatewayCoreOptions) {
    this.#options = options;
    this.link = createWorkerLink({
      authenticate: (credential) => this.#run((s) => s.authenticateWorker(credential)),
      welcome: async (workerId, hello) => {
        this.#journalIds.set(workerId, hello.journalId);
        const persisted = hello.journalId ? await this.#run((s) => s.journalCursors(workerId, hello.journalId)) : [];
        return { heartbeatIntervalSeconds: 15, persisted };
      },
      config: async (workerId) => (await this.#run((s) => s.workerConfig(workerId))) ?? undefined,
      onConnected: (connection) => void this.#serve(connection),
    });
    this.bus = new AgentBus({
      run: (effect) => this.#options.runtime.runPromise(effect),
      startThread: (row) => this.#startThread(row),
      queued: async (threadId, turn) => {
        await this.#broadcastTurn(threadId, turn.id); // re-read: the UI gets the turn with its source
        await this.pump(threadId);
      },
      steered: (steerId) => this.#sendSteer(steerId),
      interrupt: (threadId) => this.interrupt(threadId),
      answer: (by, request) => this.#answer(by, request),
      broadcastThread: (threadId) => this.#broadcastThread(threadId),
      scheduleChanged: (scheduleId) => this.#publishSchedule(scheduleId),
      modelProblem: async (thread, model, effort) => {
        const { models, provider, profile } = await this.#profileModels({ thread });
        return modelProblem(models, provider, profile, model, effort);
      },
    });
    // Ticks only after start() (main.ts); tests drive tick() directly.
    this.scheduler = new Scheduler({
      run: (effect) => this.#options.runtime.runPromise(effect),
      queued: async (threadId, turn) => {
        await this.#broadcastTurn(threadId, turn.id); // re-read: the UI gets the turn with its source
        await this.pump(threadId);
      },
      owner: options.instanceId,
      log: (message) => this.#log(message),
      changed: (scheduleId) => this.#publishSchedule(scheduleId),
    });
  }

  get online(): ReadonlySet<string> {
    return new Set([...this.link.connections.values()].filter((c) => c.isOpen).map((c) => c.workerId));
  }

  // ------------------------------------------------------------------ workers

  async #serve(connection: WorkerConnection): Promise<void> {
    const { workerId } = connection;
    await this.#run((s) => s.workerConnected(workerId, this.#options.instanceId, connection.hello));
    this.#log(`worker ${workerId} connected`);
    await this.#broadcastWorkers();
    // The outbox is read first: the turns started below (queued behind a lost one) are delivered once.
    await this.#redeliver(workerId).catch((error: unknown) => this.#log(`outbox of worker ${workerId} not redelivered: ${describeError(error)}`));
    // Turns it does not run (e.g. its process restarted) end here; the list is complete only with this capability.
    if (connection.hello.capabilities.includes("running_turns")) {
      await this.#endLostTurns({ workerId, reason: WORKER_RESTARTED, keep: connection.hello.runningTurns }).catch((error: unknown) =>
        this.#log(`lost turns of worker ${workerId} not ended: ${describeError(error)}`),
      );
    }
    try {
      for await (const message of connection.messages) {
        switch (message.payload.case) {
          case "threadEvent":
            await this.#ingest(connection, [message.payload.value]);
            break;
          case "configApplied": {
            const report = message.payload.value;
            await this.#run((s) => s.configApplied(workerId, report));
            await this.#broadcastWorkers();
            break;
          }
          case "modelCatalog": {
            const catalog = message.payload.value;
            await this.#saveModels(workerId, catalog.configVersion, catalog.profiles);
            break;
          }
          case "interactionRequest": {
            const request = message.payload.value;
            const interaction = await this.#run((s) => s.recordInteraction(request));
            this.hub.publishThread(interaction.threadId, create(ui.ThreadUpdateSchema, { change: { case: "interaction", value: interaction } }));
            await this.#broadcastThread(interaction.threadId);
            // Re-sent after a reconnect and already answered: answer again from the database.
            const answered = await this.#run((s) => s.interactionAnswer(interaction.requestId));
            if (answered) this.#sendAnswer(connection, answered.answer);
            else await this.bus.onInteraction(interaction);
            break;
          }
          case "agentToolCall": {
            const call = message.payload.value;
            // Concurrent: wait_threads may take minutes and must not hold up the stream.
            void this.bus.handle(call).then(
              (result) => {
                try {
                  connection.send({ case: "agentToolResult", value: result });
                } catch {
                  // link closed: the worker re-sends the call and gets the stored result
                }
              },
              (error: unknown) => this.#log(`agent bus call ${call.toolName} failed: ${describeError(error)}`),
            );
            break;
          }
          case "heartbeat":
            await this.#run((s) => s.workerSeen(workerId));
            break;
          case "blobChunk":
            // Before the event that points to it (same stream, handled in order).
            await this.#receiveBlob(connection, message.payload.value);
            break;
          case "fetchBlob":
            void this.#sendBlob(connection, message.payload.value);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.#log(`worker ${workerId} stream failed: ${describeError(error)}`);
    } finally {
      this.#log(`worker ${workerId} disconnected`);
      await this.#broadcastWorkers().catch(() => {});
    }
  }

  async #ingest(connection: WorkerConnection, incoming: ThreadEvent[]): Promise<void> {
    const journalId = this.#journalIds.get(connection.workerId) ?? "";
    const blocked = this.#blocked.get(connection);
    // Later events of a thread that failed would land out of order: skip them (unacked) until the resend.
    const events = blocked ? incoming.filter((e) => !blocked.has(e.threadId)) : incoming;
    if (events.length === 0) return;
    const result = await this.#options.runtime.runPromise(Ingest.use((i) => i.ingest(connection.workerId, journalId, events)));
    for (const [threadId, ackSeq] of result.acks) connection.send({ case: "eventAck", value: { threadId, ackSeq } });
    for (const unknown of result.unknownThreads) this.#log(`events for unknown thread ${unknown} kept on worker ${connection.workerId}`);
    if (result.failedThreads.length > 0) {
      const set = blocked ?? new Set<string>();
      this.#blocked.set(connection, set);
      for (const { threadId, error } of result.failedThreads) {
        this.#log(`events of thread ${threadId} not stored (kept on worker ${connection.workerId}): ${describeError(error)}`);
        set.add(threadId);
      }
      // The worker resends unacked events after reconnecting: ask for that, a little later.
      if (!blocked) {
        setTimeout(() => {
          if (!connection.isOpen) return;
          try {
            connection.send({ case: "drain", value: { reason: "redelivering events that failed to store", reconnectAfterMs: 10_000 } });
          } finally {
            connection.close();
          }
        }, 1_000);
      }
    }
    const touched = new Set<string>();
    const goals = new Set<string>();
    for (const stored of result.stored) {
      this.hub.publishThread(
        stored.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }),
      );
      const body = stored.event.body;
      if (body.case === "turnStarted" || body.case === "turnFinished") await this.#broadcastTurn(stored.threadId, stored.event.turnId);
      if (body.case === "threadReady" || body.case === "turnStarted" || body.case === "turnFinished" || body.case === "activity") touched.add(stored.threadId);
      // Thread.goal_status and Thread.background_tasks follow goals and background items.
      if (body.case === "goalState") {
        goals.add(stored.threadId);
        touched.add(stored.threadId);
        if (stored.event.turnId) await this.#broadcastTurn(stored.threadId, stored.event.turnId);
      }
      if ((body.case === "itemStarted" || body.case === "itemCompleted") && body.value.item?.content.case === "backgroundTask") touched.add(stored.threadId);
      // A steer entered its turn (user_message with its id) or never did (steer_dropped: queued by pump).
      const steerId = steerOf(stored.event);
      if (steerId) {
        await this.#publishSteer(steerId);
        touched.add(stored.threadId);
      }
    }
    for (const threadId of goals) await this.#broadcastGoal(threadId);
    // A turn ended: what it left open is closed (the worker's own reconciliation came before its turn_finished).
    for (const threadId of new Set(result.stored.filter((s) => s.event.body.case === "turnFinished").map((s) => s.threadId))) {
      await this.#settle(threadId, SETTLE_TURN_ENDED, { publishThread: false });
    }
    for (const threadId of touched) {
      await this.#broadcastThread(threadId);
      await this.pump(threadId);
    }
    for (const stored of result.stored) {
      if (stored.event.body.case === "turnFinished") await this.bus.onTurnFinished(stored.event.turnId);
    }
  }

  async #redeliver(workerId: string): Promise<void> {
    const commands = await this.#run((s) => s.pendingCommands(workerId));
    for (const command of commands) void this.#deliver(workerId, command);
  }

  // ------------------------------------------------------------------ commands

  async #dispatch(
    workerId: string,
    command: MessageInitShape<typeof CommandSchema>,
    meta: { threadId?: string; turnId?: string; ttlSeconds: number },
  ): Promise<void> {
    const stored = await this.#run((s) =>
      s.enqueueCommand({ workerId, command, ttlSeconds: meta.ttlSeconds, ...(meta.threadId && { threadId: meta.threadId }), ...(meta.turnId && { turnId: meta.turnId }) }),
    );
    void this.#deliver(workerId, stored);
  }

  /** Sends a stored command when the worker is online; offline commands wait in the outbox. */
  async #deliver(workerId: string, command: Command): Promise<void> {
    const connection = this.link.connections.get(workerId);
    if (!connection?.isOpen || !command.kind.case) return;
    let result: CommandResult;
    try {
      result = await connection.sendCommand(command.kind as CommandInit, this.#options.commandTimeoutMs ?? 60_000);
    } catch {
      return; // disconnected or timed out: stays in the outbox, redelivered on reconnect (the worker deduplicates)
    }
    await this.#run((s) => s.commandDone(command.commandId, result.ok, toJson(CommandResultSchema, result) as JsonValue));
    if (command.kind.case === "steerTurn") return this.#steerAnswered(command.kind.value.threadId, command.kind.value.inputId, result);
    if (command.kind.case === "setGoal") return this.#goalAnswered(command.kind.value.threadId, command.kind.value.goalId, result);
    if (result.ok) return;
    const reason = result.errorMessage || result.errorCode;
    switch (command.kind.case) {
      case "createThread": {
        const threadId = command.kind.value.thread?.threadId ?? "";
        await this.#run((s) => s.setThreadStatus(threadId, "failed", `${result.errorCode}: ${reason}`));
        await this.#broadcastThread(threadId);
        const failed = await this.#options.runtime.runPromise(
          AgentBusStore.use((s) => s.failQueuedTurns(threadId, `the thread could not be created: ${result.errorCode}: ${reason}`)),
        );
        for (const turnId of failed) {
          await this.#broadcastTurn(threadId, turnId);
          await this.bus.onTurnFinished(turnId);
        }
        break;
      }
      case "startTurn": {
        const { thread, turnId } = command.kind.value;
        const source = HARNESS_ERROR_CODES.has(result.errorCode) ? "harness" : "platform";
        await this.#run((s) => s.failTurn(turnId, reason, source, result.errorCode));
        await this.#broadcastTurn(thread?.threadId ?? "", turnId);
        await this.#settle(thread?.threadId ?? "", SETTLE_TURN_ENDED);
        // A Claude /goal turn: the goal shows why it did not start.
        if (await this.#goals((s) => s.turnFailed(turnId, `${result.errorCode}: ${reason}`))) await this.#broadcastGoal(thread?.threadId ?? "");
        await this.bus.onTurnFinished(turnId);
        break;
      }
      case "interruptTurn": {
        // The turn is not running there (e.g. it died with the previous worker process): it ends here.
        const { threadId, turnId } = command.kind.value;
        if (result.errorCode !== "TURN_NOT_RUNNING" && !/turn is not running/i.test(result.errorMessage)) {
          this.#log(`interrupt of ${threadId} failed on ${workerId}: ${reason}`);
          break;
        }
        await this.#endLostTurns({ workerId, reason: "the turn was no longer running on the worker", turnIds: [turnId] });
        break;
      }
      default:
        this.#log(`command ${command.kind.case} failed on ${workerId}: ${reason}`);
    }
  }

  /** Turns that no longer run on their worker end as interrupted; the threads go on with what is queued. */
  async #endLostTurns(input: Parameters<GatewayStore["Service"]["endLostTurns"]>[0]): Promise<void> {
    const { turns, interactions } = await this.#run((s) => s.endLostTurns(input));
    for (const interaction of interactions) {
      this.hub.publishThread(interaction.threadId, create(ui.ThreadUpdateSchema, { change: { case: "interaction", value: interaction } }));
    }
    for (const { threadId, turnId } of turns) {
      this.#log(`turn ${turnId} of thread ${threadId} ended: ${input.reason}`);
      await this.#broadcastTurn(threadId, turnId);
      for (const steer of await this.#steers((s) => s.ofThread(threadId))) if (steer.turn_id === turnId && steer.status === "dropped") await this.#publishSteer(steer.id);
    }
    for (const threadId of new Set(turns.map((t) => t.threadId))) {
      await this.#settle(threadId, `${SETTLE_TURN_ENDED} (${input.reason})`, { publishThread: false });
      await this.#broadcastThread(threadId);
      await this.pump(threadId);
    }
    for (const { turnId } of turns) await this.bus.onTurnFinished(turnId);
  }

  /**
   * The safety net behind every turn end (Ingest.settle): items a finished turn left open end as interrupted
   * (published like worker events), its pending interactions expire, a thread that only looks busy or broken is
   * idle again and its queue moves on.
   */
  async #settle(threadId: string, reason: string, options: { publishThread?: boolean; staleSeconds?: number } = {}): Promise<boolean> {
    if (!threadId) return false;
    const settled = await this.#options.runtime.runPromise(Ingest.use((i) => i.settle(threadId, reason, options)));
    const expired = await this.#run((s) => s.expireEndedInteractions(threadId));
    for (const stored of settled.stored) {
      this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }));
    }
    for (const interaction of expired) {
      this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "interaction", value: interaction } }));
    }
    const changed = settled.stored.length > 0 || expired.length > 0 || settled.threadChanged;
    if (changed) this.#log(`thread ${threadId} settled: ${settled.stored.length} item(s), ${expired.length} interaction(s)${settled.threadChanged ? ", idle again" : ""} (${reason})`);
    if (changed && options.publishThread !== false) {
      await this.#broadcastThread(threadId);
      await this.pump(threadId);
    }
    return changed;
  }

  /**
   * Finds and fixes what no turn end settled (docs/durability.md, "Stany tury i wątku"): open items of finished
   * turns, threads running without a running turn, interrupted or failed threads that can take turns, interactions
   * of finished turns. Idempotent; at gateway start and every few minutes. Returns the threads it changed.
   */
  async sweep(): Promise<string[]> {
    const threads = await this.#options.runtime.runPromise(Ingest.use((i) => i.unsettledThreads(SWEEP_STALE_SECONDS)));
    const changed: string[] = [];
    for (const threadId of threads) {
      try {
        if (await this.#settle(threadId, SETTLE_SWEEP, { staleSeconds: SWEEP_STALE_SECONDS })) changed.push(threadId);
      } catch (error) {
        this.#log(`sweep of thread ${threadId} failed: ${describeError(error)}`);
      }
    }
    return changed;
  }

  /** Sweeps now and then periodically (main.ts); tests call sweep() directly. */
  startSweep(intervalMs = SWEEP_INTERVAL_MS): void {
    const run = () => void this.sweep().catch((error: unknown) => this.#log(`sweep failed: ${describeError(error)}`));
    run();
    this.#sweepTimer ??= setInterval(run, intervalMs);
  }

  stopSweep(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  /** Starts the next queued turn of a thread when it is ready and nothing else runs. */
  async pump(threadId: string): Promise<void> {
    // Steers that never joined their turn run next (in order, before anything queued after them).
    for (const steerId of await this.#steers((s) => s.dropped(threadId))) await this.#queueSteer(steerId, "");
    const turn = await this.#run((s) => s.nextTurn(threadId));
    if (!turn) return;
    const thread = await this.#run((s) => s.thread(threadId));
    if (!thread.worker_id) return;
    const spec = await this.#run((s) => Effect.succeed(s.threadSpec(thread)));
    // The message's override, else the thread's default; an effort the model does not take is left out
    // (turnEffort). Recorded on the turn as what it ran with.
    const model = turn.model || thread.settings.model || "";
    const effort = turnEffort((await this.#profileModels({ thread })).models, model, turn.effort || thread.settings.effort || "");
    // The permission mode the same way: the message's override, else the thread's default (always explicit).
    const permissionMode = turn.permission_mode || permissionModeName(permissionModeOf(thread.settings.permissionMode)) || "ASK";
    if (model !== (turn.model ?? "") || effort !== (turn.effort ?? "") || permissionMode !== (turn.permission_mode ?? "")) {
      await this.#run((s) => s.setTurnSettings(turn.id, { model, effort, permissionMode }));
    }
    try {
      await this.#dispatch(
        thread.worker_id,
        {
          kind: {
            case: "startTurn",
            value: {
              thread: spec,
              turnId: turn.id,
              input: {
                text: turn.input.text ?? "",
                authorUserId: this.#options.userId,
                mentions: mentionsFromJson(turn.input.delivered),
                attachments: (turn.input.attachments ?? []).map((a) => ({
                  attachmentId: a.id,
                  sha256: a.sha256,
                  sizeBytes: BigInt(a.sizeBytes),
                  mimeType: a.mimeType,
                  name: a.name,
                  path: a.path,
                  kind: a.kind,
                })),
              },
              model,
              effort,
              permissionMode: permissionModeOf(permissionMode),
            },
          },
        },
        { threadId, turnId: turn.id, ttlSeconds: TTL.startTurn },
      );
    } catch (error) {
      // Another pass (a finished turn and a new message at once, or another instance) started it first.
      if (violates(error, "worker_commands_one_start")) return;
      throw error;
    }
  }

  // ------------------------------------------------------------------ UI operations

  async overview(): Promise<ui.GetOverviewResponse> {
    const [workers, projects] = await Promise.all([
      this.#workers(),
      this.#run((s) => s.listProjects(this.#options.userId)),
    ]);
    return create(ui.GetOverviewResponseSchema, { workers, projects, agents: [] });
  }

  async listDirectory(workerId: string, path: string): Promise<ui.ListDirectoryResponse> {
    const connection = this.link.connections.get(workerId);
    if (!connection?.isOpen) throw new UnavailableError(`worker ${workerId} is offline`);
    const result = await connection.sendCommand({ case: "listDirectory", value: { path } }, 15_000);
    if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode);
    return create(ui.ListDirectoryResponseSchema, { entries: result.entries });
  }

  async createProject(name: string): Promise<ui.Project> {
    const project = await this.#run((s) => s.createProject(this.#options.userId, name));
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
    return project;
  }

  async createWorkspace(request: ui.CreateWorkspaceRequest): Promise<ui.Workspace> {
    const workspace = await this.#run((s) =>
      s.createWorkspace({ projectId: request.projectId, workerId: request.workerId, rootPath: request.rootPath, label: request.label }),
    );
    await this.#publishProject(workspace.projectId);
    return workspace;
  }

  async updateWorkspace(request: ui.UpdateWorkspaceRequest): Promise<ui.Workspace> {
    const workspace = await this.#run((s) =>
      s.updateWorkspace(this.#options.userId, { workspaceId: request.workspaceId, rootPath: request.rootPath, label: request.label }),
    );
    await this.#publishProject(workspace.projectId);
    return workspace;
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.#run((s) => s.removeWorkspace(this.#options.userId, workspaceId));
    await this.#publishProject(workspace.projectId);
  }

  /** The project with its current workspaces, to every overview stream. */
  async #publishProject(projectId: string): Promise<void> {
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const project = projects.find((p) => p.id === projectId);
    if (project) this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
  }

  async listThreads(projectId: string): Promise<ui.Thread[]> {
    return (await this.#run((s) => s.listThreads(this.#options.userId, projectId))).map(toUiThread);
  }

  async getThread(threadId: string): Promise<ui.Thread> {
    return toUiThread(await this.#run((s) => s.thread(threadId)));
  }

  async createThread(request: ui.CreateThreadRequest): Promise<ui.Thread> {
    await this.#checkProvider(request);
    const where = { workspaceId: request.workspaceId, provider: request.provider, profileId: request.providerProfileId };
    await this.#checkModel(where, request.model, request.effort);
    // A model without efforts keeps none as the thread's default.
    const effort = turnEffort((await this.#profileModels(where)).models, request.model, request.effort);
    if (request.initialAttachmentIds.length === 0 && request.initialMentions.length === 0) {
      const row = await this.#run((s) => s.createThread(this.#options.userId, effort === request.effort ? request : { ...request, effort }));
      await this.#startThread(row);
      return toUiThread(row);
    }
    // With attachments or mentions: checked first (no thread for a message that cannot go), then the first message as a turn.
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);
    const files = request.initialAttachmentIds.length > 0 ? await this.#messageAttachments(request.initialAttachmentIds, workspace?.workerId ?? "") : undefined;
    const { mentions, goal } = await this.#messageMentions({ cwd: request.cwd || workspace?.rootPath || "" }, request.initialMessage, request.initialMentions);
    if (goal !== undefined && files) throw new InvalidError("a /goal message cannot carry attachments");
    const row = await this.#run((s) => s.createThread(this.#options.userId, { ...request, effort, initialMessage: "" }));
    if (goal === undefined) {
      const provider = request.provider === Provider.CLAUDE ? "claude" : "codex";
      const input = this.#composeInput(provider, request.initialMessage, mentions, files?.input(row.id, request.initialMessage));
      await this.#run((s) =>
        s.enqueueTurn({
          threadId: row.id,
          text: request.initialMessage,
          userId: this.#options.userId,
          clientRequestId: request.clientRequestId,
          ...(input && { input }),
        }),
      );
    }
    await this.#startThread(row);
    // A /goal first message: the new thread's goal (Claude: its /goal turn; Codex: thread/goal/set after the thread).
    if (goal !== undefined) await this.setGoal(create(ui.SetGoalRequestSchema, { threadId: row.id, action: "set", objective: goal }));
    return toUiThread(row);
  }

  // ------------------------------------------------------------------ attachments

  get attachmentLimits(): AttachmentLimits {
    return this.#options.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
  }

  /** An upload (docs/ui-api.md, "Załączniki"): typed by its content, images cleaned of metadata, owned by the user. */
  async uploadAttachment(name: string, data: Uint8Array): Promise<ui.Attachment> {
    let prepared;
    try {
      prepared = await prepareAttachment(name, data, this.attachmentLimits);
    } catch (error) {
      if (error instanceof AttachmentRejected) throw new InvalidError(error.message);
      throw error;
    }
    const row = await this.#attachments((s) => s.create({ ownerUserId: this.#options.userId, ...prepared }));
    return toUiAttachment(row);
  }

  async getAttachment(attachmentId: string, thumbnail: boolean): Promise<ui.GetAttachmentResponse> {
    const row = await this.#attachments((s) => s.owned(this.#options.userId, attachmentId));
    const sha = thumbnail ? row.thumb_sha256 : row.sha256;
    if (!sha) throw new InvalidError("this attachment has no thumbnail");
    const blob = await this.#attachments((s) => s.blob(sha));
    return create(ui.GetAttachmentResponseSchema, { attachment: toUiAttachment(row), data: blob.data, mimeType: blob.mimeType });
  }

  async getThreadBlob(threadId: string, sha256: string): Promise<ui.GetThreadBlobResponse> {
    const blob = await this.#attachments((s) => s.threadBlob(this.#options.userId, threadId, sha256));
    return create(ui.GetThreadBlobResponseSchema, { data: blob.data, mimeType: blob.mimeType });
  }

  /**
   * The attachments of a new message: the user's, unsent, within the limits, for a worker that takes attachments.
   * `input` prepares the turn input: the platform note with each file's path on that worker, then the message.
   */
  async #messageAttachments(ids: readonly string[], workerId: string): Promise<{ input(threadId: string, message: string): TurnInputJson }> {
    const limits = this.attachmentLimits;
    if (ids.length > limits.maxFiles) throw new InvalidError(`up to ${limits.maxFiles} files can be attached to one message`);
    const rows = await this.#attachments((s) => s.forMessage(this.#options.userId, ids));
    const total = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);
    if (total > limits.maxMessageBytes) throw new InvalidError(`the attachments are ${formatSize(total)}; a message can carry up to ${formatSize(limits.maxMessageBytes)}`);
    const { root, os } = await this.#attachments((s) => s.workerRoot(workerId));
    if (!root) throw new InvalidError("this thread's worker cannot take attachments yet (it has not connected since it was updated)");
    return {
      input: (threadId, message) => {
        const attachments: StoredAttachment[] = rows.map((r) => ({
          id: r.id,
          name: r.name,
          mimeType: r.mime_type,
          kind: r.kind,
          sizeBytes: Number(r.size_bytes),
          ...(r.width && { width: r.width }),
          ...(r.height && { height: r.height }),
          sha256: r.sha256,
          hasThumbnail: r.thumb_sha256 !== null,
          path: attachmentPath(root, os, threadId, r.id, r.name),
        }));
        const note = attachmentsNote(attachments);
        return { text: withAttachmentsNote(note, message), note, message, attachments };
      },
    };
  }

  /** A preview chunk from a worker; the last one stores the blob once its hash and size check out. */
  async #receiveBlob(connection: WorkerConnection, chunk: BlobChunk): Promise<void> {
    const uploads = this.#uploads.get(connection) ?? new Map();
    this.#uploads.set(connection, uploads);
    const upload = uploads.get(chunk.sha256) ?? { chunks: [], size: 0, mimeType: chunk.mimeType };
    if (BigInt(upload.size) !== chunk.offset) {
      // A gap (a lost or repeated chunk): start over from this one only if it is the first.
      uploads.delete(chunk.sha256);
      if (chunk.offset !== 0n) return;
      upload.chunks = [];
      upload.size = 0;
    }
    upload.chunks.push(chunk.data);
    upload.size += chunk.data.length;
    uploads.set(chunk.sha256, upload);
    if (upload.size > MAX_PREVIEW_BYTES) {
      uploads.delete(chunk.sha256);
      this.#log(`preview ${chunk.sha256.slice(0, 12)} from worker ${connection.workerId} is over ${formatSize(MAX_PREVIEW_BYTES)}; dropped`);
      return;
    }
    if (!chunk.last) return;
    uploads.delete(chunk.sha256);
    const data = Buffer.concat(upload.chunks);
    if (sha256Hex(data) !== chunk.sha256 || !PREVIEW_TYPES.has(upload.mimeType)) {
      this.#log(`preview ${chunk.sha256.slice(0, 12)} from worker ${connection.workerId} does not match its hash or type; dropped`);
      return;
    }
    await this.#attachments((s) => s.putBlob(chunk.sha256, new Uint8Array(data), upload.mimeType));
  }

  /** An attachment's bytes to the worker that runs its thread, in chunks (FetchBlob). */
  async #sendBlob(connection: WorkerConnection, request: FetchBlob): Promise<void> {
    const reply = (value: { offset?: bigint; data?: Uint8Array; last: boolean; error?: string }) => {
      try {
        connection.send({ case: "blobChunk", value: { requestId: request.requestId, sha256: request.sha256, ...value } });
        return true;
      } catch {
        return false; // link closed: the worker asks again with the redelivered StartTurn
      }
    };
    let data: Uint8Array;
    try {
      data = await this.#attachments((s) => s.workerBlob(connection.workerId, request.threadId, request.sha256));
    } catch (error) {
      reply({ last: true, error: error instanceof NotFound ? "attachment not found" : `attachment not readable: ${describeError(error)}` });
      return;
    }
    for (let offset = 0; offset < data.length || offset === 0; offset += BLOB_CHUNK_BYTES) {
      const end = Math.min(offset + BLOB_CHUNK_BYTES, data.length);
      if (!reply({ offset: BigInt(offset), data: data.subarray(offset, end), last: end >= data.length })) return;
      if (end >= data.length) break;
    }
  }

  #attachments<A, E>(use: (store: AttachmentStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(AttachmentStore.use(use));
  }

  // ------------------------------------------------------------------ mentions (docs/ui-api.md, "Wzmianki")

  /** Commands, skills and plugins of the scope's provider (worker, cached CATALOG_TTL_MS), the platform's commands first. */
  async listMentionCatalog(request: ui.ListMentionCatalogRequest): Promise<ui.ListMentionCatalogResponse> {
    const scope = await this.#mentionScope(request.scope);
    const key = `${scope.workerId}|${scope.provider}|${scope.profileId}|${scope.cwd}`;
    const cached = this.#catalogs.get(key);
    let catalog = !request.refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS ? cached.catalog : undefined;
    if (!catalog) {
      const result = await this.#workerQuery(
        scope.workerId,
        { case: "listMentionCatalog", value: { provider: scope.provider, profileId: scope.profileId, cwd: scope.cwd, refresh: request.refresh } },
        45_000,
      );
      catalog = result.mentionCatalog ?? create(MentionCatalogSchema, { provider: scope.provider, profileId: scope.profileId, cwd: scope.cwd });
      this.#catalogs.set(key, { at: Date.now(), catalog });
      if (this.#catalogs.size > 200) this.#catalogs.delete(this.#catalogs.keys().next().value ?? "");
    }
    // Goals need a worker thread of either provider; the platform runs /goal itself (SetGoal).
    const entries = [...PLATFORM_COMMANDS, ...catalog.entries.filter((e) => !PLATFORM_COMMANDS.some((p) => p.kind === e.kind && p.name === e.name))];
    return create(ui.ListMentionCatalogResponseSchema, { catalog: { ...catalog, entries } });
  }

  /** Fuzzy file search in the scope's folder on its worker. */
  async searchFiles(request: ui.SearchFilesRequest): Promise<ui.SearchFilesResponse> {
    const scope = await this.#mentionScope(request.scope);
    const result = await this.#workerQuery(scope.workerId, { case: "searchFiles", value: { cwd: scope.cwd, query: request.query, limit: request.limit } }, 20_000);
    return create(ui.SearchFilesResponseSchema, { ...(result.fileSearch && { result: result.fileSearch }) });
  }

  /** The user's threads by title (fuzzy), best match first, the most recent activity first among equals. */
  async searchThreads(request: ui.SearchThreadsRequest): Promise<ui.SearchThreadsResponse> {
    const limit = Math.min(request.limit || 20, 50);
    const activity = (t: ui.Thread) => (t.lastActivityAt ? timestampDate(t.lastActivityAt).getTime() : 0);
    const threads = (await this.#run((s) => s.listThreads(this.#options.userId, "")))
      .map(toUiThread)
      .filter((t) => t.id !== request.excludeThreadId)
      .sort((a, b) => activity(b) - activity(a));
    const ranked = fuzzyRank(request.query, threads, (t) => [t.title || "Untitled"], limit);
    return create(ui.SearchThreadsResponseSchema, { threads: ranked.map((r) => r.item) });
  }

  /** Worker, provider, profile and folder of a thread, or of a new thread in a workspace. */
  async #mentionScope(scope: ui.MentionScope | undefined): Promise<{ workerId: string; provider: Provider; profileId: string; cwd: string }> {
    if (scope?.threadId) {
      const thread = await this.#run((s) => s.thread(scope.threadId));
      if (thread.owner_user_id !== this.#options.userId) throw new InvalidError("thread not found");
      if (!thread.worker_id || thread.runtime !== "worker") throw new InvalidError("this thread has no worker");
      return {
        workerId: thread.worker_id,
        provider: thread.provider === "claude" ? Provider.CLAUDE : Provider.CODEX,
        profileId: thread.provider_profile_id || "native",
        cwd: thread.cwd ?? "",
      };
    }
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === scope?.workspaceId);
    if (!workspace) throw new InvalidError("workspace not found");
    return {
      workerId: workspace.workerId,
      provider: scope?.provider || Provider.CODEX,
      profileId: scope?.providerProfileId || "native",
      cwd: scope?.cwd || workspace.rootPath,
    };
  }

  /** A read-only command to an online worker; offline = Unavailable with a message the popup shows. */
  async #workerQuery(workerId: string, kind: CommandInit, timeoutMs: number): Promise<CommandResult> {
    const connection = this.link.connections.get(workerId);
    if (!connection?.isOpen) {
      const worker = (await this.#run((s) => s.listWorkers(this.online))).find((w) => w.id === workerId);
      throw new UnavailableError(`${worker?.name || "the worker"} is offline`);
    }
    const result = await connection.sendCommand(kind, timeoutMs);
    if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode);
    return result;
  }

  /**
   * A user's message with mentions: checked against the text, files resolved to their path on the worker, threads
   * to the user's own (their title as the label). A platform command (/goal) is returned apart: the rest of the text
   * is its argument.
   */
  async #messageMentions(thread: { id?: string; cwd: string }, text: string, mentions: readonly Mention[]): Promise<{ mentions: Mention[]; goal?: string }> {
    if (mentions.length === 0) return { mentions: [] };
    let checked: Mention[];
    try {
      checked = checkMentions(text, mentions);
    } catch (error) {
      if (error instanceof MentionError) throw new InvalidError(error.message);
      throw error;
    }
    const command = checked.find(isPlatformCommand);
    if (command) {
      if (command.name !== "goal") throw new InvalidError(`unknown platform command /${command.name}`);
      return { mentions: [], goal: `${text.slice(0, command.start)}${text.slice(command.end)}`.replace(/\s+/g, " ").trim() };
    }
    const resolved: Mention[] = [];
    for (const m of checked) {
      if (m.kind === MentionKind.FILE) {
        resolved.push(create(MentionSchema, { ...m, path: workerPath(thread.cwd, m.name) }));
      } else if (m.kind === MentionKind.THREAD) {
        const target = await this.#run((s) => s.thread(m.name)).catch(() => undefined);
        if (!target || target.owner_user_id !== this.#options.userId || target.id === thread.id) throw new InvalidError("a mentioned thread was not found");
        resolved.push(create(MentionSchema, { ...m, label: target.title || "Untitled" }));
      } else {
        resolved.push(m);
      }
    }
    return { mentions: resolved };
  }

  /** The turn (or steer) input of a message with mentions: composed for the provider after the other notes. */
  #composeInput(provider: string, message: string, mentions: readonly Mention[], base: TurnInputJson | undefined): TurnInputJson | undefined {
    if (mentions.length === 0) return base;
    const composed = composeMessage(provider === "claude" ? Provider.CLAUDE : Provider.CODEX, message, mentions, base?.note ? [base.note] : []);
    return { ...base, text: composed.text, note: composed.note, message, mentions: mentionsToJson(mentions), delivered: mentionsToJson(composed.mentions) };
  }

  /**
   * The worker's last report (ConfigApplied) must offer the provider and the profile for it. A worker that
   * has not reported yet is not judged: the thread waits for it like for an offline worker.
   */
  async #checkProvider(request: ui.CreateThreadRequest): Promise<void> {
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);
    if (!workspace) return; // the store reports the missing workspace
    const worker = (await this.#workers()).find((w) => w.id === workspace.workerId);
    if (!worker || worker.appliedVersion === 0n) return;
    const name = request.provider === Provider.CLAUDE ? "Claude" : "Codex";
    const provider = worker.providers.find((p) => p.provider === request.provider);
    if (!provider?.available) throw new InvalidError(`${name} is not available on ${worker.name}${provider?.detail ? `: ${provider.detail}` : ""}`);
    const profileId = request.providerProfileId || "native";
    const instance = worker.providerInstances.find((i) => i.harness === request.provider && i.id === profileId);
    if (!instance) throw new InvalidError(`${name} has no provider instance "${profileId}"`);
    if (!instance.enabled) throw new InvalidError(`${name} · ${instance.label || profileId} is turned off on ${worker.name}`);
    const profile = worker.profiles.find((p) => p.id === profileId && p.providers.includes(request.provider));
    if (!profile) throw new InvalidError(`${name} · ${instance.label || profileId} is not applied on ${worker.name} yet`);
    if (!profile.available) throw new InvalidError(`${name} · ${instance.label || profileId} is not available on ${worker.name}${profile.detail ? `: ${profile.detail}` : ""}`);
  }

  /** CreateThread to the worker (with the fork point of a forked thread), then announce the thread. */
  async #startThread(row: ThreadRow): Promise<void> {
    const spec = await this.#run((s) => Effect.succeed(s.threadSpec(row)));
    let fork: MessageInitShape<typeof ForkSpecSchema> | undefined;
    if (row.fork_source_thread_id) {
      const source = await this.#run((s) => s.thread(row.fork_source_thread_id ?? ""));
      const turns = await this.#run((s) => s.turnsOf(source.id));
      const last = [...turns].reverse().find((t) => t.status === "completed");
      fork = {
        sourceThreadId: source.id,
        sourceProviderThreadId: source.provider_thread_id ?? "",
        afterTurnId: last?.id ?? "",
        afterProviderTurnRef: last?.provider_turn_ref ?? "",
      };
    }
    await this.#dispatch(
      row.worker_id ?? "",
      { kind: { case: "createThread", value: { thread: spec, ...(fork && { fork }) } } },
      { threadId: row.id, ttlSeconds: TTL.createThread },
    );
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: toUiThread(row) } }));
  }

  /**
   * A message: the next turn (queue), or into the running turn (steer; without one it is queued too).
   * Idempotent by client_request_id across both.
   */
  async sendMessage(request: ui.SendMessageRequest): Promise<{ turn?: ui.Turn; steer?: ui.Steer; goal?: ui.Goal }> {
    const { threadId, clientRequestId } = request;
    const thread = await this.#run((s) => s.thread(threadId));
    if (thread.owner_user_id !== this.#options.userId) throw new InvalidError("thread not found");
    const existingSteer = await this.#steers((s) => s.byClientRequest(threadId, clientRequestId));
    if (existingSteer) return { steer: toUiSteer(existingSteer) };
    const existingTurn = await this.#run((s) => s.turnByClientRequest(threadId, clientRequestId));
    if (existingTurn) return { turn: toUiTurn(existingTurn) };
    const files = request.attachmentIds.length > 0 ? await this.#messageAttachments(request.attachmentIds, thread.worker_id ?? "") : undefined;
    if (!request.text.trim() && !files) throw new InvalidError("message is empty");
    const { mentions, goal } = await this.#messageMentions({ id: thread.id, cwd: thread.cwd ?? "" }, request.text, request.mentions);
    if (goal !== undefined) {
      // The platform's /goal: the rest of the message is the objective (docs/goals.md).
      if (files) throw new InvalidError("a /goal message cannot carry attachments");
      return { goal: await this.setGoal(create(ui.SetGoalRequestSchema, { threadId, action: "set", objective: goal })) };
    }
    // Only the message's own effort is judged: the thread's default falls back when the turn starts (turnEffort).
    await this.#checkModel({ thread }, request.model || thread.settings.model || "", request.effort);
    const permissionMode = checkedPermissionMode(request.permissionMode);
    // A message with attachments is always the next turn: its files go to the worker before the turn starts.
    if (request.delivery === ui.MessageDelivery.STEER && !files) {
      const running = await this.#run((s) => s.runningTurn(threadId));
      if (running && thread.worker_id) {
        const steerInput = this.#composeInput(thread.provider, request.text, mentions, undefined);
        const steer = await this.#steers((s) =>
          s.create({
            threadId,
            turnId: running.id,
            text: request.text,
            userId: this.#options.userId,
            clientRequestId,
            model: request.model,
            effort: request.effort,
            permissionMode,
            ...(steerInput && { input: { ...steerInput, text: steerInput.text ?? request.text } }),
          }),
        );
        await this.#sendSteer(steer.id);
        return { steer: toUiSteer(await this.#steers((s) => s.steer(steer.id))) };
      }
    }
    const input = this.#composeInput(thread.provider, request.text, mentions, files?.input(threadId, request.text));
    const turn = await this.#run((s) =>
      s.enqueueTurn({
        threadId,
        text: request.text,
        userId: this.#options.userId,
        clientRequestId,
        model: request.model,
        effort: request.effort,
        permissionMode,
        ...(input && { input }),
      }),
    );
    const update = toUiTurn(turn);
    this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: update } }));
    await this.pump(threadId);
    return { turn: update };
  }

  /** The thread's default model, effort and permission mode for turns without an override. */
  async updateThread(request: ui.UpdateThreadRequest): Promise<ui.Thread> {
    const thread = await this.#run((s) => s.thread(request.threadId));
    if (thread.owner_user_id !== this.#options.userId || thread.archived_at) throw new InvalidError("thread not found");
    const model = request.model ?? thread.settings.model ?? "";
    // The requested effort is judged; the current default follows a new model (none without efforts, else the
    // model's default when it does not offer it).
    await this.#checkModel({ thread }, model, request.effort ?? "");
    const current = thread.settings.effort ?? "";
    const effort = turnEffort((await this.#profileModels({ thread })).models, model, request.effort ?? current);
    // Only the owner (UI) changes the mode; agents have no bus tool for it (docs/ui-api.md, FULL_AUTO only deliberately).
    const permissionMode = request.permissionMode === undefined ? "" : checkedPermissionMode(request.permissionMode);
    const row = await this.#run((s) =>
      s.updateThreadSettings(request.threadId, {
        ...(request.model !== undefined && { model: request.model }),
        ...((request.effort !== undefined || effort !== current) && { effort }),
        ...(permissionMode && { permissionMode }),
      }),
    );
    await this.#broadcastThread(row.id);
    return toUiThread(row);
  }

  // ------------------------------------------------------------------ models and steers

  /** Catalogs of the user's workers; refresh asks the worker(s) again (online ones). */
  async listModels(request: ui.ListModelsRequest): Promise<ui.WorkerModels[]> {
    const workers = (await this.#workers()).filter((w) => !request.workerId || w.id === request.workerId);
    if (request.workerId && workers.length === 0) throw new InvalidError("worker not found");
    if (request.refresh) {
      const online = workers.filter((w) => w.online);
      if (request.workerId && online.length === 0) throw new UnavailableError(`worker ${request.workerId} is offline`);
      await Promise.all(
        online.map(async (worker) => {
          const connection = this.link.connections.get(worker.id);
          if (!connection?.isOpen) return;
          const result = await connection.sendCommand({ case: "listModels", value: {} }, 90_000);
          if (!result.ok) throw new InvalidError(result.errorMessage || result.errorCode);
          await this.#saveModels(worker.id, worker.appliedVersion, result.models);
        }),
      );
    }
    const catalogs = await this.#models((s) => s.catalogs(workers.map((w) => w.id)));
    return request.unfiltered ? catalogs : this.#forPickers(catalogs);
  }

  async #saveModels(workerId: string, configVersion: bigint, profiles: ui.WorkerModels["profiles"]): Promise<void> {
    const models = await this.#models((s) => s.save({ workerId, configVersion, profiles }));
    await this.#publishModels([models]);
  }

  /** Live catalogs are what pickers show: with the profiles' model selections applied. */
  async #publishModels(catalogs: ui.WorkerModels[]): Promise<void> {
    for (const models of await this.#forPickers(catalogs)) {
      this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "models", value: models } }));
    }
  }

  /** The instances' model choices: hidden models, custom models, favorites first (store/instance-config.ts). */
  async #forPickers(catalogs: ui.WorkerModels[]): Promise<ui.WorkerModels[]> {
    if (catalogs.length === 0) return catalogs;
    const rules = await this.#instances((s) => s.modelRules());
    return catalogs.map((catalog) => applyInstanceModels(catalog, rules));
  }

  // ------------------------------------------------------------------ provider instances

  /** Every global instance with its state on every worker; no secret values, only whether they are set. */
  async listProviderInstances(): Promise<ui.ProviderInstance[]> {
    return this.#instances((s) => s.list());
  }

  /** New or changed instance: new configuration versions for the workers it runs on, sent to the online ones. */
  async saveProviderInstance(request: ui.SaveProviderInstanceRequest): Promise<ui.ProviderInstance> {
    const { harness, id, changed } = await this.#instances((s) => s.save({ userId: this.#options.userId, request }));
    await this.#configsChanged(changed);
    return this.#instances((s) => s.get(harness, id));
  }

  async deleteProviderInstance(request: ui.DeleteProviderInstanceRequest): Promise<void> {
    await this.#configsChanged(await this.#instances((s) => s.remove({ userId: this.#options.userId, request })));
  }

  async setInstanceWorkers(request: ui.SetInstanceWorkersRequest): Promise<ui.ProviderInstance> {
    await this.#configsChanged(await this.#instances((s) => s.setWorkers({ userId: this.#options.userId, request })));
    return this.#instance(request.harness, request.id);
  }

  async setInstanceWorker(request: ui.SetInstanceWorkerRequest): Promise<ui.ProviderInstance> {
    await this.#configsChanged(await this.#instances((s) => s.setWorker({ userId: this.#options.userId, request })));
    return this.#instance(request.harness, request.id);
  }

  /** Favorites, visibility and custom models: pickers change at once, the workers' configurations do not. */
  async setInstanceModels(request: ui.SetInstanceModelsRequest): Promise<ui.ProviderInstance> {
    await this.#instances((s) => s.setModels(request));
    await this.#publishModels(await this.#models((s) => s.catalogs([])));
    await this.#broadcastWorkers();
    return this.#instance(request.harness, request.id);
  }

  /**
   * Versions, availability and logins checked again on the online workers (ProbeProviders: each answers with a new
   * ConfigApplied for the same version). Workers that are offline or too old are listed as skipped.
   */
  async refreshProviders(request: ui.RefreshProvidersRequest): Promise<ui.RefreshProvidersResponse> {
    const workers = (await this.#workers()).filter((w) => !request.workerId || w.id === request.workerId);
    if (request.workerId && workers.length === 0) throw new InvalidError("worker not found");
    const skipped: string[] = [];
    await Promise.all(
      workers.map(async (worker) => {
        const connection = this.link.connections.get(worker.id);
        if (!connection?.isOpen) return void skipped.push(`${worker.name}: offline`);
        if (!connection.hello.capabilities.includes("probe_providers")) return void skipped.push(`${worker.name}: the worker is too old to check again`);
        const result = await connection.sendCommand({ case: "probeProviders", value: {} }, 60_000).catch((error: unknown) => ({ ok: false, errorMessage: describeError(error), errorCode: "" }));
        if (!result.ok) skipped.push(`${worker.name}: ${result.errorMessage || result.errorCode}`);
      }),
    );
    return create(ui.RefreshProvidersResponseSchema, { instances: await this.listProviderInstances(), skipped });
  }

  /** Login of an instance through the harness's API (Codex: ChatGPT device code); the worker finishes it. */
  async startProviderLogin(request: ui.StartProviderLoginRequest): Promise<ui.StartProviderLoginResponse> {
    const connection = this.link.connections.get(request.workerId);
    if (!connection?.isOpen) throw new UnavailableError("the worker is offline");
    if (!connection.hello.capabilities.includes("codex_device_login")) throw new InvalidError("this worker cannot sign in from the app; update it");
    if (request.harness !== Provider.CODEX) throw new InvalidError("only Codex signs in from the app; sign in to Claude Code on the device");
    const result = await connection.sendCommand({ case: "startLogin", value: { provider: request.harness, profileId: request.id } }, 60_000);
    if (!result.ok || !result.login) throw new InvalidError(result.errorMessage || result.errorCode || "the login did not start");
    return create(ui.StartProviderLoginResponseSchema, { verificationUrl: result.login.verificationUrl, userCode: result.login.userCode });
  }

  /** Writes the effective instances of every worker that is behind (gateway start; after a migration). */
  async syncProviderInstances(): Promise<void> {
    await this.#configsChanged(await this.#instances((s) => s.sync(this.#options.userId)));
  }

  async #instance(harness: Provider, id: string): Promise<ui.ProviderInstance> {
    const name = harnessOf(harness);
    if (!name) throw new InvalidError("choose Claude or Codex");
    return this.#instances((s) => s.get(name, id));
  }

  /** The stored configurations go to the workers (each answers ConfigApplied and a new model catalog). */
  async #configsChanged(workerIds: readonly string[]): Promise<void> {
    for (const workerId of workerIds) {
      const config = await this.#run((s) => s.workerConfig(workerId));
      if (config) this.link.pushConfig(workerId, config);
    }
    await this.#broadcastWorkers();
  }

  #instances<A, E>(use: (store: InstanceStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(InstanceStore.use(use));
  }

  /** Workers with their instances (Worker.provider_instances). */
  async #workers(): Promise<ui.Worker[]> {
    const [workers, instances] = await Promise.all([this.#run((s) => s.listWorkers(this.online)), this.#instances((s) => s.workerInstances())]);
    for (const worker of workers) worker.providerInstances = instances.get(worker.id) ?? [];
    return workers;
  }

  /**
   * A model and effort must be offered by the profile's catalog when the worker has reported one (no catalog,
   * or an incomplete one, is not judged: the worker has the final word when the turn starts).
   */
  async #checkModel(where: ModelScope, model: string, effort: string): Promise<void> {
    const { models, provider, profile } = await this.#profileModels(where);
    const problem = modelProblem(models, provider, profile, model, effort);
    if (problem) throw new InvalidError(problem);
  }

  /** The worker's last catalog for the thread's (or the new thread's) provider and profile. */
  async #profileModels(where: ModelScope): Promise<{ models: ProfileModels | undefined; provider: Provider; profile: string }> {
    let workerId: string | undefined;
    let provider: Provider;
    let profileId: string;
    if ("thread" in where) {
      workerId = where.thread.worker_id ?? undefined;
      provider = where.thread.provider === "claude" ? Provider.CLAUDE : Provider.CODEX;
      profileId = where.thread.provider_profile_id ?? "";
    } else {
      const projects = await this.#run((s) => s.listProjects(this.#options.userId));
      workerId = projects.flatMap((p) => p.workspaces).find((w) => w.id === where.workspaceId)?.workerId;
      provider = where.provider;
      profileId = where.profileId;
    }
    const profile = profileId && profileId !== "native" ? profileId : "native";
    const catalog = workerId ? (await this.#models((s) => s.catalogs([workerId]))).at(0) : undefined;
    const listed = catalog?.profiles.find((p) => p.provider === provider && p.profileId === profile);
    // The instance's custom models are accepted like listed ones.
    const rule = listed && (await this.#instances((s) => s.modelRules())).find((r) => r.harness === harnessOf(provider) && r.id === profile);
    return { models: listed && withCustomModels(listed, rule), provider, profile };
  }

  /** SteerTurn to the worker (outbox); the result decides between accepted and the queue. */
  async #sendSteer(steerId: string): Promise<void> {
    const steer = await this.#steers((s) => s.steer(steerId));
    const thread = await this.#run((s) => s.thread(steer.thread_id));
    await this.#publishSteer(steerId);
    if (!thread.worker_id) return void (await this.#queueSteer(steerId, "the thread has no worker"));
    await this.#dispatch(
      thread.worker_id,
      {
        kind: {
          case: "steerTurn",
          value: {
            threadId: steer.thread_id,
            turnId: steer.turn_id,
            inputId: steer.id,
            input: {
              text: steer.input.text,
              authorUserId: steer.author_user_id ?? "",
              authorAgentId: steer.source_thread_id ?? "",
              mentions: mentionsFromJson(steer.input.delivered),
            },
          },
        },
      },
      { threadId: steer.thread_id, ttlSeconds: TTL.steerTurn },
    );
  }

  async #steerAnswered(threadId: string, steerId: string, result: CommandResult): Promise<void> {
    if (result.ok) {
      await this.#steers((s) => s.accepted(steerId));
      await this.#publishSteer(steerId);
      return;
    }
    const reason =
      result.errorCode === "STEER_NOT_RUNNING"
        ? "the turn ended before the message could join it"
        : `the provider did not take the message into the running turn: ${result.errorMessage || result.errorCode}`;
    await this.#queueSteer(steerId, reason);
    await this.pump(threadId);
  }

  /** The steer runs as the next turn instead (reason "" keeps the stored one, e.g. from a steer_dropped notice). */
  async #queueSteer(steerId: string, reason: string): Promise<void> {
    const current = await this.#steers((s) => s.steer(steerId));
    const { steer, turn } = await this.#steers((s) => s.queue(steerId, reason || current.reason || "the turn ended before the message could join it"));
    this.hub.publishThread(steer.thread_id, create(ui.ThreadUpdateSchema, { change: { case: "steer", value: toUiSteer(steer) } }));
    if (turn) await this.#broadcastTurn(steer.thread_id, turn.id);
  }

  async #publishSteer(steerId: string): Promise<void> {
    const steer = await this.#steers((s) => s.steer(steerId)).catch(() => undefined);
    if (steer) this.hub.publishThread(steer.thread_id, create(ui.ThreadUpdateSchema, { change: { case: "steer", value: toUiSteer(steer) } }));
  }

  #models<A, E>(use: (store: ModelStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(ModelStore.use(use));
  }

  #steers<A, E>(use: (store: SteerStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(SteerStore.use(use));
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = await this.#run((s) => s.thread(threadId));
    const turn = await this.#run((s) => s.runningTurn(threadId));
    if (!turn || !thread.worker_id) return;
    await this.#dispatch(
      thread.worker_id,
      { kind: { case: "interruptTurn", value: { threadId, turnId: turn.id } } },
      { threadId, turnId: turn.id, ttlSeconds: TTL.interruptTurn },
    );
  }

  async answerInteraction(request: ui.AnswerInteractionRequest): Promise<ui.Interaction> {
    return this.#answer({ userId: this.#options.userId }, request);
  }

  /** Stores the answer (user or parent agent), announces it and passes it to the waiting worker. */
  async #answer(by: { userId: string } | { threadId: string }, request: ui.AnswerInteractionRequest): Promise<ui.Interaction> {
    const interaction = await this.#run((s) => s.answerInteraction(request.requestId, by, request));
    this.hub.publishThread(interaction.threadId, create(ui.ThreadUpdateSchema, { change: { case: "interaction", value: interaction } }));
    await this.#broadcastThread(interaction.threadId);
    const thread = await this.#run((s) => s.thread(interaction.threadId));
    const connection = thread.worker_id ? this.link.connections.get(thread.worker_id) : undefined;
    // Offline: the worker re-sends the request after reconnecting and gets the stored answer.
    if (connection?.isOpen) this.#sendAnswer(connection, request);
    return interaction;
  }

  /** Snapshot first, then live updates after it (subscribe before reading, skip what the snapshot has). */
  async *watchThread(threadId: string, signal: AbortSignal): AsyncGenerator<ui.ThreadUpdate> {
    const subscription = this.hub.subscribeThread(threadId);
    signal.addEventListener("abort", () => subscription.close(), { once: true });
    try {
      const snapshot = await this.#run((s) => s.snapshot(threadId));
      yield create(ui.ThreadUpdateSchema, {
        change: {
          case: "snapshot",
          value: {
            thread: toUiThread(snapshot.thread),
            turns: snapshot.turns.map(toUiTurn),
            items: snapshot.items,
            interactions: snapshot.interactions,
            notices: snapshot.notices,
            schedules: (await this.#bus((s) => s.schedulesFor({ ownerUserId: this.#options.userId, threadId, includeFinished: false }))).map(toUiSchedule),
            steers: (await this.#steers((s) => s.ofThread(threadId))).map(toUiSteer),
            ...(await this.#goals((s) => s.latest(threadId)).then((goal) => goal && { goal: toUiGoal(goal) })),
            lastSeq: snapshot.lastSeq,
          },
        },
      });
      for await (const update of subscription.updates) {
        if (update.change.case === "event" && update.change.value.seq <= snapshot.lastSeq) continue;
        yield update;
      }
    } finally {
      subscription.close();
    }
  }

  async *watchOverview(signal: AbortSignal): AsyncGenerator<ui.OverviewUpdate> {
    const subscription = this.hub.subscribeOverview();
    signal.addEventListener("abort", () => subscription.close(), { once: true });
    try {
      yield* subscription.updates;
    } finally {
      subscription.close();
    }
  }

  // ------------------------------------------------------------------ settings (UI)

  async settings(): Promise<ui.GetSettingsResponse> {
    const [user, projects] = await Promise.all([
      this.#settings((s) => s.user(this.#options.userId)),
      this.#settings((s) => s.projects(this.#options.userId)),
    ]);
    const limits = this.attachmentLimits;
    return create(ui.GetSettingsResponseSchema, {
      user,
      projects,
      attachmentLimits: { maxFileBytes: BigInt(limits.maxFileBytes), maxMessageBytes: BigInt(limits.maxMessageBytes), maxFiles: limits.maxFiles },
    });
  }

  /** The sidebar width is held within its limits instead of refused (a drag past them is not an error). */
  async updateUserSettings(request: ui.UpdateUserSettingsRequest): Promise<ui.UserSettings> {
    if (request.threadDefaults) await this.#checkThreadDefaults(request.threadDefaults);
    if (request.modelFavorites) checkFavorites(request.modelFavorites);
    const settings = await this.#settings((s) =>
      s.updateUser({
        userId: this.#options.userId,
        ...(request.appearance && { appearance: { ...request.appearance, sidebarWidth: storedSidebarWidth(request.appearance.sidebarWidth) } }),
        ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
        ...(request.modelFavorites && { modelFavorites: request.modelFavorites }),
        expectedVersion: request.expectedVersion,
      }),
    );
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "userSettings", value: settings } }));
    return settings;
  }

  async updateProjectSettings(request: ui.UpdateProjectSettingsRequest): Promise<ui.ProjectSettings> {
    if (request.threadDefaults) await this.#checkThreadDefaults(request.threadDefaults, request.projectId);
    const settings = await this.#settings((s) =>
      s.updateProject({
        userId: this.#options.userId,
        projectId: request.projectId,
        ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
        expectedVersion: request.expectedVersion,
      }),
    );
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "projectSettings", value: settings } }));
    return settings;
  }

  /** Defaults must point at the user's own workspace (in the project, for project settings). */
  async #checkThreadDefaults(defaults: ui.ThreadDefaults, projectId?: string): Promise<void> {
    if (defaults.providerProfileId.length > 100 || defaults.models.some((m) => m.model.length > 200)) throw new InvalidError("model or profile id is too long");
    if (new Set(defaults.models.map((m) => m.provider)).size !== defaults.models.length) throw new InvalidError("one model per provider");
    if (!defaults.workspaceId) return;
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === defaults.workspaceId);
    if (!workspace || (projectId && workspace.projectId !== projectId)) throw new InvalidError("workspace not found");
  }

  #settings<A, E>(use: (store: SettingsStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(SettingsStore.use(use));
  }

  // ------------------------------------------------------------------ schedules (UI)

  async listSchedules(request: ui.ListSchedulesRequest): Promise<ui.Schedule[]> {
    const rows = await this.#bus((s) =>
      s.schedulesFor({ ownerUserId: this.#options.userId, projectId: request.projectId, threadId: request.threadId, includeFinished: request.includeFinished }),
    );
    return rows.map(toUiSchedule);
  }

  /** A user's schedule: like an agent's, but it may be open-ended and starts no agent chain (hops 0). */
  async createSchedule(request: ui.CreateScheduleRequest): Promise<ui.Schedule> {
    const thread = await this.#run((s) => s.thread(request.threadId));
    if (thread.owner_user_id !== this.#options.userId) throw new InvalidError("thread not found");
    if (thread.archived_at) throw new InvalidError("the thread is archived");
    const prompt = request.prompt.trim();
    if (!prompt) throw new InvalidError("prompt is required");
    const missedPolicy = request.missedPolicy || "run_once";
    if (missedPolicy !== "run_once" && missedPolicy !== "skip") throw new InvalidError("missed_policy is run_once or skip");
    const now = new Date();
    const until = request.until ? timestampDate(request.until) : undefined;
    if (until && until <= now) throw new InvalidError("until is in the past");
    let row: ScheduleRow;
    if (request.when.case === "runAt") {
      const runAt = timestampDate(request.when.value);
      if (runAt.getTime() < now.getTime() - 60_000) throw new InvalidError("run_at is in the past");
      row = await this.#bus((s) =>
        s.createUserSchedule({
          userId: this.#options.userId,
          schedule: { threadId: thread.id, kind: "once", prompt, runAt, timezone: "UTC", nextRunAt: runAt, hops: 0, missedPolicy },
        }),
      );
    } else if (request.when.case === "cron") {
      const cron = request.when.value;
      const timezone = request.timezone || "UTC";
      if (!isTimeZone(timezone)) throw new InvalidError(`unknown time zone ${timezone}`);
      const problem = cronProblem(cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);
      if (problem) throw new InvalidError(problem);
      const nextRunAt = nextCronRun(cron, timezone, now);
      if (!nextRunAt) throw new InvalidError("cron has no future runs");
      row = await this.#bus((s) =>
        s.createUserSchedule({
          userId: this.#options.userId,
          schedule: {
            threadId: thread.id,
            kind: "recurring",
            prompt,
            cron,
            timezone,
            ...(until && { until }),
            ...(request.maxRuns > 0 && { maxRuns: request.maxRuns }),
            nextRunAt,
            hops: 0,
            missedPolicy,
          },
        }),
      );
    } else {
      throw new InvalidError("set run_at or cron");
    }
    const schedule = toUiSchedule(row);
    this.#announceSchedule(schedule);
    return schedule;
  }

  /** Next runs of a cron in a time zone, validated like CreateSchedule. */
  previewSchedule(request: ui.PreviewScheduleRequest): ui.PreviewScheduleResponse {
    const timezone = request.timezone || "UTC";
    if (!isTimeZone(timezone)) throw new InvalidError(`unknown time zone ${timezone}`);
    const now = new Date();
    const problem = cronProblem(request.cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);
    if (problem) throw new InvalidError(problem);
    const count = Math.min(Math.max(request.count || 5, 1), 20);
    const nextRuns = [];
    for (let at = now; nextRuns.length < count; ) {
      const next = nextCronRun(request.cron, timezone, at);
      if (!next) break;
      nextRuns.push(timestampFromDate(next));
      at = next;
    }
    return create(ui.PreviewScheduleResponseSchema, { nextRuns });
  }

  async setScheduleStatus(request: ui.SetScheduleStatusRequest): Promise<ui.Schedule> {
    const status = request.status;
    if (status !== "active" && status !== "paused" && status !== "cancelled") throw new InvalidError("status is active, paused or cancelled");
    const current = await this.#bus((s) => s.schedule(request.scheduleId));
    const owner = await this.#run((s) => s.thread(current.thread_id));
    if (owner.owner_user_id !== this.#options.userId) throw new InvalidError("schedule not found");
    let nextRunAt: Date | undefined;
    if (status === "active") {
      // Resumed: a missed one-off runs now; a recurring one continues from now.
      const now = new Date();
      nextRunAt =
        current.kind === "once"
          ? new Date(Math.max(new Date(current.run_at ?? now).getTime(), now.getTime()))
          : current.cron
            ? nextCronRun(current.cron, current.timezone, now)
            : undefined;
      if (!nextRunAt) throw new InvalidError("the schedule has no future runs");
    }
    const row = await this.#bus((s) => s.setScheduleStatus({ scheduleId: request.scheduleId, status, ...(nextRunAt && { nextRunAt }) }));
    const schedule = toUiSchedule(row);
    this.#announceSchedule(schedule);
    return schedule;
  }

  async #publishSchedule(scheduleId: string): Promise<void> {
    const row = await this.#bus((s) => s.schedule(scheduleId)).catch(() => undefined);
    if (row) this.#announceSchedule(toUiSchedule(row));
  }

  #announceSchedule(schedule: ui.Schedule): void {
    this.hub.publishThread(schedule.threadId, create(ui.ThreadUpdateSchema, { change: { case: "schedule", value: schedule } }));
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "schedule", value: schedule } }));
  }

  #bus<A, E>(use: (store: AgentBusStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(AgentBusStore.use(use));
  }

  // ------------------------------------------------------------------ goals and background work (UI)

  /**
   * The user's goal actions (docs/goals.md). The goal row records the decision at once; the harness confirms
   * through goal_state events.
   * - Codex: SetGoal to the worker (thread/goal/set|clear). Codex continues the thread by itself.
   * - Claude: `/goal …` as a queued turn of the goal. Claude has no pause: pause and clear interrupt the
   *   running turn (the evaluator keeps a goal turn going) and queue `/goal clear`; resume sets it again.
   */
  async setGoal(request: ui.SetGoalRequest): Promise<ui.Goal> {
    const thread = await this.#run((s) => s.thread(request.threadId));
    if (thread.owner_user_id !== this.#options.userId) throw new InvalidError("thread not found");
    if (thread.archived_at) throw new InvalidError("the thread is archived");
    if (thread.runtime !== "worker" || !thread.worker_id) throw new InvalidError("goals need a worker thread");
    const claude = thread.provider === "claude";
    const current = await this.#goals((s) => s.latest(thread.id));
    const open = current && !isFinished(current.status) ? current : undefined;
    let goal: GoalRow;
    switch (request.action) {
      case "set": {
        const objective = request.objective.trim();
        if (!objective) throw new InvalidError("objective is required");
        if (objective.length > MAX_OBJECTIVE) throw new InvalidError(`objective is limited to ${MAX_OBJECTIVE} characters`);
        if (claude && request.tokenBudget > 0n) throw new InvalidError("Claude goals have no token budget");
        if (claude && open?.status === "active") await this.interrupt(thread.id);
        goal = await this.#goals((s) => s.create({ threadId: thread.id, objective, tokenBudget: request.tokenBudget, userId: this.#options.userId }));
        await this.#goalToHarness(thread, goal, GoalDirective.RUN, objective, request.tokenBudget);
        break;
      }
      case "pause":
        if (open?.status !== "active") throw new InvalidError("no active goal to pause");
        goal = await this.#goals((s) => s.setStatus(open.id, "paused"));
        await this.#goalToHarness(thread, goal, GoalDirective.PAUSE);
        break;
      case "resume":
        if (!open || open.status === "active") throw new InvalidError("no paused goal to resume");
        goal = await this.#goals((s) => s.setStatus(open.id, "active"));
        // A goal the harness never confirmed (its set failed) is set again, with its objective and budget.
        if (open.native_status) await this.#goalToHarness(thread, goal, GoalDirective.RUN);
        else await this.#goalToHarness(thread, goal, GoalDirective.RUN, goal.objective, BigInt(goal.token_budget ?? 0));
        break;
      case "clear":
        if (!open) throw new InvalidError("no open goal to clear");
        goal = await this.#goals((s) => s.setStatus(open.id, "cancelled"));
        await this.#goalToHarness(thread, goal, GoalDirective.CLEAR);
        break;
      default:
        throw new InvalidError("action is set, pause, resume or clear");
    }
    const update = toUiGoal(goal);
    this.hub.publishThread(thread.id, create(ui.ThreadUpdateSchema, { change: { case: "goal", value: update } }));
    await this.#broadcastThread(thread.id);
    return update;
  }

  async #goalToHarness(thread: ThreadRow, goal: GoalRow, directive: GoalDirective, objective = "", tokenBudget = 0n): Promise<void> {
    if (thread.provider === "claude") {
      // The evaluator keeps a goal turn running: stopping the goal stops the turn.
      if (directive !== GoalDirective.RUN) await this.interrupt(thread.id);
      const text = claudeGoalCommand(directive === GoalDirective.RUN ? goal.objective : undefined);
      const turn = await this.#goals((s) => s.enqueueGoalTurn({ threadId: thread.id, goalId: goal.id, text }));
      this.hub.publishThread(thread.id, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }));
      await this.pump(thread.id);
      return;
    }
    const spec = await this.#run((s) => Effect.succeed(s.threadSpec(thread)));
    await this.#dispatch(
      thread.worker_id ?? "",
      { kind: { case: "setGoal", value: { threadId: thread.id, goalId: goal.id, objective, directive, nativeTokenBudget: tokenBudget, thread: spec } } },
      { threadId: thread.id, ttlSeconds: TTL.setGoal },
    );
  }

  /** Stops a running background task (StopTask to the worker; the item ends when the worker reports it). */
  async stopBackgroundTask(request: ui.StopBackgroundTaskRequest): Promise<void> {
    const thread = await this.#run((s) => s.thread(request.threadId));
    if (thread.owner_user_id !== this.#options.userId) throw new InvalidError("thread not found");
    const item = await this.#run((s) => s.threadItem(thread.id, request.itemId));
    if (item?.content.case !== "backgroundTask") throw new InvalidError("background task not found");
    if (item.status !== ItemStatus.IN_PROGRESS) throw new InvalidError("the background task is not running");
    if (!thread.worker_id) throw new InvalidError("the thread has no worker");
    await this.#dispatch(
      thread.worker_id,
      { kind: { case: "stopTask", value: { threadId: thread.id, taskId: item.content.value.taskId } } },
      { threadId: thread.id, ttlSeconds: TTL.stopTask },
    );
  }

  /** SetGoal answered: a failure is shown on the goal (and its status goes back), a success clears it. */
  async #goalAnswered(threadId: string, goalId: string, result: CommandResult): Promise<void> {
    if (!goalId) return;
    if (result.ok) {
      if (await this.#goals((s) => s.commandSucceeded(goalId))) await this.#broadcastGoal(threadId);
      return;
    }
    const error = result.errorMessage ? `${result.errorCode}: ${result.errorMessage}` : result.errorCode;
    this.#log(`goal command for thread ${threadId} failed: ${error}`);
    const goal = await this.#goals((s) => s.commandFailed(goalId, error));
    this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "goal", value: toUiGoal(goal) } }));
    await this.#broadcastThread(threadId);
  }

  async #broadcastGoal(threadId: string): Promise<void> {
    const goal = await this.#goals((s) => s.latest(threadId));
    if (goal) this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "goal", value: toUiGoal(goal) } }));
  }

  #goals<A, E>(use: (store: GoalStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(GoalStore.use(use));
  }

  // ------------------------------------------------------------------ helpers

  #sendAnswer(connection: WorkerConnection, answer: ui.AnswerInteractionRequest): void {
    try {
      connection.send({
        case: "interactionResponse",
        value: create(InteractionResponseSchema, {
          requestId: answer.requestId,
          allow: answer.allow,
          allowForSession: answer.allowForSession,
          message: answer.message,
          answerJson: answer.answerJson,
          cancelled: answer.cancelled,
        }),
      });
    } catch {
      // closed meanwhile: re-sent request gets the stored answer
    }
  }

  async #broadcastThread(threadId: string): Promise<void> {
    const thread = toUiThread(await this.#run((s) => s.thread(threadId)));
    this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "thread", value: thread } }));
    this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: thread } }));
  }

  async #broadcastTurn(threadId: string, turnId: string): Promise<void> {
    const turn = (await this.#run((s) => s.turnsOf(threadId))).find((t) => t.id === turnId);
    if (turn) this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }));
  }

  async #broadcastWorkers(): Promise<void> {
    for (const worker of await this.#workers()) {
      this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "worker", value: worker } }));
    }
  }

  #run<A, E>(use: (store: GatewayStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#options.runtime.runPromise(GatewayStore.use(use));
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }
}

/** The steer an event concerns: its user_message item (client_id) or a steer_dropped notice. */
function steerOf(event: ThreadEvent): string | undefined {
  const body = event.body;
  if (body.case === "itemCompleted" && body.value.item?.content.case === "userMessage") {
    const clientId = body.value.item.content.value.clientId;
    return clientId && clientId !== event.turnId ? clientId : undefined;
  }
  if (body.case === "notice" && body.value.code === "steer_dropped") {
    try {
      const id = (JSON.parse(body.value.dataJson || "{}") as { input_id?: unknown }).input_id;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A requested permission mode as stored ('' = UNSPECIFIED: no override / unchanged). Any mode is the user's to
 * choose for their thread (FULL_AUTO too: still sandboxed to the workspace by both harnesses); agents cannot
 * set one, the agent bus has no tool for it.
 */
function checkedPermissionMode(mode: PermissionMode): string {
  if (mode !== PermissionMode.UNSPECIFIED && PermissionMode[mode] === undefined) throw new InvalidError(`unknown permission mode ${mode}`);
  return permissionModeName(mode);
}

/** Whether a database constraint caused the error (driver errors carry it somewhere in the cause chain). */
function violates(error: unknown, constraint: string): boolean {
  for (let current = error, i = 0; i < 8 && current && typeof current === "object"; i++, current = (current as { cause?: unknown }).cause) {
    if ((current as { constraint?: unknown }).constraint === constraint) return true;
  }
  return false;
}

/** Favorites are a short list of known shapes: a provider, an optional profile, a model id. */
function checkFavorites(favorites: ui.ModelFavorites): void {
  if (favorites.models.length > 200) throw new InvalidError("at most 200 favorite models");
  for (const f of favorites.models) {
    if (f.provider !== Provider.CLAUDE && f.provider !== Provider.CODEX) throw new InvalidError("a favorite model needs a provider");
    if (!f.model || f.model.length > 200 || f.profileId.length > 100) throw new InvalidError("a favorite model needs a model id (at most 200 characters)");
  }
  const keys = favorites.models.map((f) => `${f.provider}/${f.profileId}/${f.model}`);
  if (new Set(keys).size !== keys.length) throw new InvalidError("duplicate favorite model");
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Message with its causes (driver errors keep the useful part, e.g. the violated constraint, in the cause). */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error, i = 0; current && i < 5; i++, current = (current as { cause?: unknown }).cause) {
    const message = current instanceof Error ? current.message : String(current);
    const detail = (current as { detail?: unknown }).detail;
    parts.push(typeof detail === "string" && detail ? `${message} (${detail})` : message);
    if (typeof current !== "object") break;
  }
  return [...new Set(parts)].join(": ");
}

export class UnavailableError extends Error {
  override readonly name = "UnavailableError";
}
export class InvalidError extends Error {
  override readonly name = "InvalidError";
}

