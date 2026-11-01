import { create, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import {
  CommandResultSchema,
  CommandSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  ui,
  type Command,
  type CommandResult,
  type ThreadEvent,
} from "@open-agents/contracts";
import { Effect, type ManagedRuntime } from "effect";
import { createWorkerLink, type CommandInit, type WorkerConnection, type WorkerLink } from "../worker-link/index.ts";
import { AgentBusStore, GatewayStore, Ingest, toUiThread, toUiTurn, type ThreadRow } from "../store/index.ts";
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

export type CoreRuntime = ManagedRuntime.ManagedRuntime<GatewayStore | Ingest | AgentBusStore, unknown>;

export interface GatewayCoreOptions {
  readonly runtime: CoreRuntime;
  readonly instanceId: string;
  /** Single development user until authentication lands (docs/ui-api.md). */
  readonly userId: string;
  readonly log?: (message: string) => void;
  readonly commandTimeoutMs?: number;
}

const TTL = { createThread: 24 * 3600, startTurn: 24 * 3600, interruptTurn: 60 } as const;

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
        this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }));
        await this.pump(threadId);
      },
      interrupt: (threadId) => this.interrupt(threadId),
      answer: (by, request) => this.#answer(by, request),
      broadcastThread: (threadId) => this.#broadcastThread(threadId),
    });
    // Ticks only after start() (main.ts); tests drive tick() directly.
    this.scheduler = new Scheduler({
      run: (effect) => this.#options.runtime.runPromise(effect),
      queued: async (threadId, turn) => {
        this.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }));
        await this.pump(threadId);
      },
      owner: options.instanceId,
      log: (message) => this.#log(message),
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
    for (const stored of result.stored) {
      this.hub.publishThread(
        stored.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }),
      );
      const body = stored.event.body.case;
      if (body === "turnStarted" || body === "turnFinished") await this.#broadcastTurn(stored.threadId, stored.event.turnId);
      if (body === "threadReady" || body === "turnStarted" || body === "turnFinished" || body === "activity") touched.add(stored.threadId);
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
    await this.#dispatch(
      thread.worker_id,
      { kind: { case: "startTurn", value: { thread: spec, turnId: turn.id, input: { text: turn.input.text ?? "", authorUserId: this.#options.userId } } } },
      { threadId, turnId: turn.id, ttlSeconds: TTL.startTurn },
    );
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
    return (await this.#run((s) => s.listThreads(projectId))).map(toUiThread);
  }

  async createThread(request: ui.CreateThreadRequest): Promise<ui.Thread> {
    const row = await this.#run((s) => s.createThread(this.#options.userId, request));
    await this.#startThread(row);
    return toUiThread(row);
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

