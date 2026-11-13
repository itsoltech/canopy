import type { JsonValue } from "@bufbuild/protobuf";
import type { AgentBusCall } from "@canopy/domain";
import type { Effect } from "effect";
import { BackgroundTaskStore, type TurnRow } from "../store/index.ts";

/**
 * Background tasks and their agents (docs/execution.md, "Zadania w tle", "Pobudka"; docs/agent-bus.md):
 *
 * - tools: list_background_tasks, get_background_task, stop_background_task (agent bus calls; AgentBus authorized
 *   them) answered from the timeline,
 * - notes: every end of a task reaches the thread's agent. Ingest writes the note with the end; deliver() steers it
 *   into the running turn or queues a turn of its own (trigger background_task). It runs after events are stored
 *   (an end, a turn start), when a note steer did not join its turn, and on a timer (Claude's grace period, notes
 *   that waited for a running turn, a gateway restart in between).
 */

export interface BackgroundTasksHost {
  run<A, E>(effect: Effect.Effect<A, E, BackgroundTaskStore>): Promise<A>;
  /** A turn was queued: announce it and start it when the thread is free. */
  queued(threadId: string, turn: TurnRow): Promise<void>;
  /** Recover a note turn committed before its dispatch, including after a gateway restart. */
  pump(threadId: string): Promise<void>;
  /** A steer was stored: send it to the worker. */
  steered(steerId: string): Promise<void>;
  /** The user's Stop for a background item (StopTask to the worker). */
  stop(threadId: string, itemId: string): Promise<void>;
  log(message: string): void;
}

export interface BackgroundTasksOptions {
  /** How long a Claude task that completed by itself waits for Claude's own wake-up turn (default 15 s). */
  readonly graceMs?: number;
}

type BackgroundCall = Extract<
  AgentBusCall,
  { tool: "list_background_tasks" | "get_background_task" | "stop_background_task" }
>;

const DEFAULT_GRACE_MS = 15_000;
const TICK_MS = 2_000;

export class BackgroundTasks {
  readonly #host: BackgroundTasksHost;
  readonly #graceMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Threads being delivered: a second call waits for the first one, then runs again. */
  readonly #running = new Map<string, Promise<void>>();

  constructor(host: BackgroundTasksHost, options: BackgroundTasksOptions = {}) {
    this.#host = host;
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** An agent bus call about background tasks, for the calling thread (or the thread it names). */
  async tool(call: BackgroundCall, callerId: string): Promise<JsonValue> {
    const threadId = call.args.thread_id ?? callerId;

    switch (call.tool) {
      case "list_background_tasks": {
        const tasks = await this.#host.run(
          BackgroundTaskStore.use((s) => s.list(threadId, call.args.status ?? "all", call.args.limit ?? 20)),
        );

        return {
          tasks: tasks.map((task) => ({ ...task })),
          ...(tasks.length === 0 && { note: "This thread has no background tasks." }),
        };
      }

      case "get_background_task": {
        const task = await this.#host.run(
          BackgroundTaskStore.use((s) => s.get(threadId, call.args.task_id, call.args.output_lines ?? 80)),
        );

        if (!task)
          throw new Refusal(
            `background task ${call.args.task_id} not found in this thread; list_background_tasks shows its tasks`,
          );

        return { ...task };
      }

      case "stop_background_task": {
        const task = await this.#host.run(BackgroundTaskStore.use((s) => s.find(threadId, call.args.task_id)));

        if (!task)
          throw new Refusal(
            `background task ${call.args.task_id} not found in this thread; list_background_tasks shows its tasks`,
          );

        if (!task.running)
          throw new Refusal(
            `background task ${call.args.task_id} is not running any more; get_background_task shows how it ended`,
          );
        // The agent knows: its end brings no note.
        await this.#host.run(BackgroundTaskStore.use((s) => s.stoppedByAgent(threadId, task.itemId)));
        await this.#host.stop(threadId, task.itemId);

        return {
          task_id: task.itemId,
          stopping: true,
          note: "Asked the worker to stop it; it ends as stopped. Check with get_background_task.",
        };
      }
    }
  }

  /** Hands the thread's waiting notes to its agent (idempotent; one pass per thread at a time). */
  async deliver(threadId: string): Promise<void> {
    const previous = this.#running.get(threadId);

    const next = (previous ?? Promise.resolve())
      .then(() => this.#deliver(threadId))
      .catch((cause: unknown) =>
        this.#host.log(`background notes of thread ${threadId} not delivered: ${describe(cause)}`),
      );

    this.#running.set(threadId, next);
    await next;

    if (this.#running.get(threadId) === next) this.#running.delete(threadId);
  }

  async #deliver(threadId: string): Promise<void> {
    const delivery = await this.#host.run(
      BackgroundTaskStore.use((s) => s.deliver(threadId, { graceMs: this.#graceMs })),
    );

    if (delivery.turn) {
      this.#host.log(`background task note for thread ${threadId}: turn ${delivery.turn.id}`);
      await this.#host.queued(threadId, delivery.turn);
    }

    if (delivery.steerId) {
      this.#host.log(`background task note for thread ${threadId}: steer ${delivery.steerId}`);
      await this.#host.steered(delivery.steerId);
    }
  }

  /**
   * A steer that did not join its turn: when it is a note's, its notes wait again and are delivered anew (a turn of
   * their own, the next turn). Returns false for other steers.
   */
  async release(threadId: string, steerId: string, reason: string): Promise<boolean> {
    const mine = await this.#host.run(BackgroundTaskStore.use((s) => s.release(steerId, reason)));

    if (mine) await this.deliver(threadId);

    return mine;
  }

  /** Every thread with notes that may move now. */
  async tick(): Promise<void> {
    const steers = await this.#host.run(BackgroundTaskStore.use((s) => s.pendingSteers()));

    for (const steerId of steers) await this.#host.steered(steerId);

    const threads = await this.#host.run(BackgroundTaskStore.use((s) => s.pendingThreads()));

    for (const threadId of threads) {
      await this.deliver(threadId);
      await this.#host.pump(threadId);
    }
  }

  /** Delivers now and then every few seconds (main.ts; tests call tick() or start a short interval). */
  start(intervalMs = TICK_MS): void {
    const run = () =>
      void this.tick().catch((cause: unknown) => this.#host.log(`background notes: ${describe(cause)}`));

    run();
    this.#timer ??= setInterval(run, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** A reason for the model (AgentBus returns errors named Invalid to it). */
class Refusal extends Error {
  override readonly name = "Invalid";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
