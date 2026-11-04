import type { Effect } from "effect";
import { AgentBusStore, GatewayStore, type ScheduleRow, type TurnRow } from "../store/index.ts";
import type { FiredSchedule } from "../store/agent-bus.ts";
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
  run<A, E>(effect: Effect.Effect<A, E, AgentBusStore | GatewayStore>): Promise<A>;
  queued(threadId: string, turn: TurnRow): Promise<void>;
  readonly owner: string;
  log(message: string): void;
  /** A schedule ran (or completed, or was cancelled with its thread): announce it. */
  changed(scheduleId: string): Promise<void>;
  eligibleWorkers(schedule: ScheduleRow): Promise<readonly string[]>;
  created(result: NonNullable<FiredSchedule["created"]>, prompt: string): Promise<void>;
}

const LEASE_SECONDS = 60;

/** A run later than this after its time counts as missed (missed_policy applies). */
const MISSED_AFTER_MS = 2 * 60_000;

/** Coalesce downtime to one occurrence; timezone and interval validation stay in cron.ts. */
export function scheduleTiming(
  schedule: Pick<ScheduleRow, "next_run_at" | "kind" | "cron" | "timezone" | "missed_policy">,
  now: Date,
) {
  const late = now.getTime() - new Date(schedule.next_run_at ?? now).getTime() > MISSED_AFTER_MS;
  let nextRunAt: Date | undefined;

  if (schedule.kind === "recurring" && schedule.cron) {
    try {
      nextRunAt = nextCronRun(schedule.cron, schedule.timezone, now);
    } catch {
      /* A parser change must not leave a schedule in an endless loop. */
    }
  }

  return { late, run: !(late && schedule.missed_policy === "skip"), nextRunAt };
}

export class Scheduler {
  readonly #host: SchedulerHost;
  readonly #tickMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<unknown> = Promise.resolve();
  #ticking = false;

  constructor(host: SchedulerHost, tickMs = 5_000) {
    this.#host = host;
    this.#tickMs = tickMs;
  }

  start(): void {
    this.#timer ??= setInterval(() => {
      if (this.#ticking) return;
      this.#running = this.tick().catch((error: unknown) =>
        this.#host.log(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`),
      );
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
    if (this.#ticking) return 0;
    this.#ticking = true;

    try {
      const due = await this.#host.run(
        AgentBusStore.use((s) => s.claimDueSchedules(this.#host.owner, now, LEASE_SECONDS)),
      );

      for (const schedule of due) {
        try {
          await this.#fire(schedule, now);
        } catch (error) {
          this.#host.log(`schedule ${schedule.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return due.length;
    } finally {
      this.#ticking = false;
    }
  }

  async #fire(schedule: ScheduleRow, now: Date): Promise<void> {
    const { late, run, nextRunAt } = scheduleTiming(schedule, now);

    const runLabel =
      schedule.kind === "once"
        ? "wake-up"
        : `run ${schedule.runs + 1}${schedule.max_runs ? ` of ${schedule.max_runs}` : ""}`;

    const input = {
      note: `[canopy] Scheduled ${runLabel} (schedule_id: ${schedule.id}${late ? ", delayed" : ""}):`,
      message: schedule.prompt,
    };

    const eligibleWorkerIds = schedule.target === "new_thread" ? await this.#host.eligibleWorkers(schedule) : [];

    const fired = await this.#host.run(
      AgentBusStore.use((s) => s.fireSchedule({ schedule, input, run, nextRunAt, eligibleWorkerIds, now })),
    );

    if (fired.created) await this.#host.created(fired.created, schedule.prompt);

    if (fired.turn) await this.#host.queued(fired.threadId, fired.turn);
    await this.#host.changed(schedule.id);
  }
}
