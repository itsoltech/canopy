import { create, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import {
  CommandResultSchema,
  CommandSchema,
  ForkSpecSchema,
  GoalDirective,
  InteractionResponseSchema,
  ItemStatus,
  Provider,
  ui,
  type Command,
  type CommandResult,
  type ThreadEvent,
} from "@open-agents/contracts";
import { Effect, type ManagedRuntime } from "effect";
import { createWorkerLink, type CommandInit, type WorkerConnection, type WorkerLink } from "../worker-link/index.ts";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { claudeGoalCommand, DEFAULT_BUS_LIMITS, isFinished } from "@open-agents/domain";
import {
  AgentBusStore,
  GatewayStore,
  GoalStore,
  Ingest,
  SettingsStore,
  toUiGoal,
  toUiSchedule,
  toUiThread,
  toUiTurn,
  type GoalRow,
  type ScheduleRow,
  type ThreadRow,
} from "../store/index.ts";
import { cronProblem, nextCronRun } from "./cron.ts";
import { AgentBus } from "./agent-bus.ts";
import { Hub } from "./hub.ts";
import { Scheduler } from "./scheduler.ts";

/**
 * The gateway's runtime state machine (docs/ui-api.md, docs/durability.md):
 * - workers: connect, outbox redelivery, transcript ingest + ack after commit, config, interactions,
 * - scheduler: one running turn per thread; a turn starts only once the thread is ready,
 * - command results: failed thread creation / turn start become visible state, not silent drops,
 * - agent bus: tool calls from agents (side threads, messages, waits), notifications, questions to parents,
 * - UI operations and live fan-out through the hub.
 */

export type CoreRuntime = ManagedRuntime.ManagedRuntime<GatewayStore | Ingest | AgentBusStore | SettingsStore | GoalStore, unknown>;

export interface GatewayCoreOptions {
  readonly runtime: CoreRuntime;
  readonly instanceId: string;
  /** Single development user until authentication lands (docs/ui-api.md). */
  readonly userId: string;
  readonly log?: (message: string) => void;
  readonly commandTimeoutMs?: number;
}

const TTL = { createThread: 24 * 3600, startTurn: 24 * 3600, interruptTurn: 60, setGoal: 3600, stopTask: 300 } as const;

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
      interrupt: (threadId) => this.interrupt(threadId),
      answer: (by, request) => this.#answer(by, request),
      broadcastThread: (threadId) => this.#broadcastThread(threadId),
      scheduleChanged: (scheduleId) => this.#publishSchedule(scheduleId),
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
    void this.#redeliver(workerId);
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
    }
    for (const threadId of goals) await this.#broadcastGoal(threadId);
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
        await this.#run((s) => s.failTurn(turnId, `${result.errorCode}: ${reason}`));
        await this.#broadcastTurn(thread?.threadId ?? "", turnId);
        await this.bus.onTurnFinished(turnId);
        break;
      }
      default:
        this.#log(`command ${command.kind.case} failed on ${workerId}: ${reason}`);
    }
  }

  /** Starts the next queued turn of a thread when it is ready and nothing else runs. */
  async pump(threadId: string): Promise<void> {
    const turn = await this.#run((s) => s.nextTurn(threadId));
    if (!turn) return;
    const thread = await this.#run((s) => s.thread(threadId));
    if (!thread.worker_id) return;
    const spec = await this.#run((s) => Effect.succeed(s.threadSpec(thread)));
    try {
      await this.#dispatch(
        thread.worker_id,
        { kind: { case: "startTurn", value: { thread: spec, turnId: turn.id, input: { text: turn.input.text ?? "", authorUserId: this.#options.userId } } } },
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
      this.#run((s) => s.listWorkers(this.online)),
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
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const project = projects.find((p) => p.id === request.projectId);
    if (project) this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
    return workspace;
  }

  async listThreads(projectId: string): Promise<ui.Thread[]> {
    return (await this.#run((s) => s.listThreads(this.#options.userId, projectId))).map(toUiThread);
  }

  async getThread(threadId: string): Promise<ui.Thread> {
    return toUiThread(await this.#run((s) => s.thread(threadId)));
  }

  async createThread(request: ui.CreateThreadRequest): Promise<ui.Thread> {
    await this.#checkProvider(request);
    const row = await this.#run((s) => s.createThread(this.#options.userId, request));
    await this.#startThread(row);
    return toUiThread(row);
  }

  /**
   * The worker's last report (ConfigApplied) must offer the provider and the profile for it. A worker that
   * has not reported yet is not judged: the thread waits for it like for an offline worker.
   */
  async #checkProvider(request: ui.CreateThreadRequest): Promise<void> {
    const projects = await this.#run((s) => s.listProjects(this.#options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);
    if (!workspace) return; // the store reports the missing workspace
    const worker = (await this.#run((s) => s.listWorkers(this.online))).find((w) => w.id === workspace.workerId);
    if (!worker || worker.appliedVersion === 0n) return;
    const name = request.provider === Provider.CLAUDE ? "Claude" : "Codex";
    const provider = worker.providers.find((p) => p.provider === request.provider);
    if (!provider?.available) throw new InvalidError(`${name} is not available on ${worker.name}${provider?.detail ? `: ${provider.detail}` : ""}`);
    const profileId = request.providerProfileId || "native";
    const profile = worker.profiles.find((p) => p.id === profileId);
    if (!profile) throw new InvalidError(`profile "${profileId}" is not configured on ${worker.name}`);
    if (!profile.providers.includes(request.provider)) throw new InvalidError(`profile "${profileId}" does not serve ${name}`);
    if (!profile.available) throw new InvalidError(`profile "${profileId}" is not available on ${worker.name}${profile.detail ? `: ${profile.detail}` : ""}`);
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

  async sendMessage(request: ui.SendMessageRequest): Promise<ui.Turn> {
    const turn = await this.#run((s) =>
      s.enqueueTurn({ threadId: request.threadId, text: request.text, userId: this.#options.userId, clientRequestId: request.clientRequestId }),
    );
    const update = toUiTurn(turn);
    this.hub.publishThread(request.threadId, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: update } }));
    await this.pump(request.threadId);
    return update;
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
    return create(ui.GetSettingsResponseSchema, { user, projects });
  }

  async updateUserSettings(request: ui.UpdateUserSettingsRequest): Promise<ui.UserSettings> {
    if (request.threadDefaults) await this.#checkThreadDefaults(request.threadDefaults);
    const settings = await this.#settings((s) =>
      s.updateUser({
        userId: this.#options.userId,
        ...(request.appearance && { appearance: request.appearance }),
        ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
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
        await this.#goalToHarness(thread, goal, GoalDirective.RUN);
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
    for (const worker of await this.#run((s) => s.listWorkers(this.online))) {
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

/** Whether a database constraint caused the error (driver errors carry it somewhere in the cause chain). */
function violates(error: unknown, constraint: string): boolean {
  for (let current = error, i = 0; i < 8 && current && typeof current === "object"; i++, current = (current as { cause?: unknown }).cause) {
    if ((current as { constraint?: unknown }).constraint === constraint) return true;
  }
  return false;
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

