import type { Effect } from "effect";
import { AgentBusStore, type ScheduleRow, type TurnRow } from "../store/index.ts";
import { nextCronRun } from "./cron.ts";

/**
 * Platform scheduler (docs/agent-bus.md#5-harmonogram): replaces provider-native timers. Due schedules
 * are leased (FOR UPDATE SKIP LOCKED, safe with several gateway instances) and fire as turns with
 * trigger = schedule; a worker that is offline gets the turn when it reconnects, like any other turn.
 *
 * After downtime a recurring schedule runs once to catch up (missed_policy = run_once) or skips the
 * missed runs (skip); either way the next run is computed from now.
 */

export interface SchedulerHost {
  run<A, E>(effect: Effect.Effect<A, E, AgentBusStore>): Promise<A>;
  queued(threadId: string, turn: TurnRow): Promise<void>;
  readonly owner: string;
  log(message: string): void;
  /** A schedule ran (or completed, or was cancelled with its thread): announce it. */
  changed(scheduleId: string): Promise<void>;
}

const LEASE_SECONDS = 60;
/** A run later than this after its time counts as missed (missed_policy applies). */
const MISSED_AFTER_MS = 2 * 60_000;

export class Scheduler {
  readonly #host: SchedulerHost;
  readonly #tickMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<unknown> = Promise.resolve();

  constructor(host: SchedulerHost, tickMs = 5_000) {
    this.#host = host;
    this.#tickMs = tickMs;
  }

  start(): void {
    this.#timer ??= setInterval(() => {
      this.#running = this.tick().catch((error: unknown) => this.#host.log(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.#tickMs);
  }

  /** Stops ticking and waits for the current tick (graceful shutdown). */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** Fires what is due at `now`. Returns the number of schedules handled. */
  async tick(now = new Date()): Promise<number> {
    const due = await this.#host.run(AgentBusStore.use((s) => s.claimDueSchedules(this.#host.owner, now, LEASE_SECONDS)));
    for (const schedule of due) await this.#fire(schedule, now);
    return due.length;
  }

  async #fire(schedule: ScheduleRow, now: Date): Promise<void> {
    const late = now.getTime() - new Date(schedule.next_run_at ?? now).getTime() > MISSED_AFTER_MS;
    const run = !(late && schedule.missed_policy === "skip");
    let nextRunAt: Date | undefined;
    if (schedule.kind === "recurring" && schedule.cron) {
      try {
        nextRunAt = nextCronRun(schedule.cron, schedule.timezone, now);
      } catch {
        nextRunAt = undefined; // checked when created; a parser change must not loop
      }
    }
    const runLabel = schedule.kind === "once" ? "wake-up" : `run ${schedule.runs + 1}${schedule.max_runs ? ` of ${schedule.max_runs}` : ""}`;
    const input = { note: `[open-agents] Scheduled ${runLabel} (schedule_id: ${schedule.id}${late ? ", delayed" : ""}):`, message: schedule.prompt };
    const fired = await this.#host.run(AgentBusStore.use((s) => s.fireSchedule({ schedule, input, run, nextRunAt })));
    if (fired.turn) await this.#host.queued(fired.threadId, fired.turn);
    await this.#host.changed(schedule.id);
  }
}
