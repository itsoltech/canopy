import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@open-agents/contracts";
import cronstrue from "cronstrue";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { cronProblem, nextCronRun } from "../core/cron.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { nextHop } from "./policy.ts";
import type { BotRow, BotTurn } from "./types.ts";

export const ROUTINE_LIMIT = 20;
export const ROUTINE_MIN_MINUTES = 15;
interface RoutineRow {
  id: string; bot_id: string; title: string; instructions: string; cron: string; timezone: string;
  schedule_text: string; enabled: boolean; hops: number; created_at: Date; updated_at: Date;
  last_run_at: Date | null; next_run_at: Date | null; last_outcome: string; run_count: number;
}
export interface RoutineOrigin { routineId?: string; routineTitle?: string }
export interface RoutinePatch { title?: string; instructions?: string; cron?: string; timezone?: string; enabled?: boolean }
type Fx<A> = Effect.Effect<A, SqlError.SqlError | Invalid | NotFound>;
interface Hooks {
  owned(user: string, botId: string, lock?: boolean): Fx<BotRow>;
  changed(botId: string): Fx<unknown>;
  enqueue(user: string, botId: string, input: string, requestId: string, options: RoutineOrigin & { hops?: number; sender?: string; event?: boolean }): Fx<string>;
}
const at = (date: Date | null) => date ? timestampFromDate(new Date(date)) : undefined;
export const routineView = (r: RoutineRow) => create(bots.BotRoutineSchema, {
  id: r.id, botId: r.bot_id, title: r.title, instructions: r.instructions, cron: r.cron, timezone: r.timezone,
  scheduleText: r.schedule_text, enabled: r.enabled, createdAt: at(r.created_at), updatedAt: at(r.updated_at),
  lastRunAt: at(r.last_run_at), nextRunAt: at(r.next_run_at), lastOutcome: r.last_outcome, runCount: r.run_count,
});
export const originOf = (turn: Pick<BotTurn, "routine_id" | "routine_title"> | undefined): RoutineOrigin =>
  turn?.routine_id ? { routineId: turn.routine_id, routineTitle: turn.routine_title } : {};

/** Called inside BotStore's transactions: bot -> routine -> turn is the lock order. */
export function routineStore(sql: SqlClient.SqlClient, hooks: Hooks) {
  const rows = (botId: string) => sql<RoutineRow>`SELECT * FROM bot_routines WHERE bot_id = ${botId}::uuid AND deleted_at IS NULL ORDER BY created_at, id`;
  const get = (botId: string, id: string) => sql<RoutineRow>`SELECT * FROM bot_routines WHERE id = ${id}::uuid AND bot_id = ${botId}::uuid AND deleted_at IS NULL`
    .pipe(Effect.flatMap((r) => r[0] ? Effect.succeed(r[0]) : Effect.fail(new NotFound("routine not found"))));
  const stop = (id: string) => Effect.gen(function* () {
    const stopped = yield* sql`UPDATE bot_turns SET status = 'interrupted', lease_token = NULL, lease_until = NULL, finished_at = now()
      WHERE routine_id = ${id}::uuid AND status IN ('queued','running','waiting') RETURNING id`;
    if (stopped.length) yield* sql`UPDATE bot_routines SET last_outcome = 'Stopped' WHERE id = ${id}::uuid`;
    yield* sql`UPDATE bot_approvals SET status = 'discarded', answered_at = now() WHERE status = 'pending'
      AND turn_id IN (SELECT id FROM bot_turns WHERE routine_id = ${id}::uuid AND status = 'interrupted')`;
  });
  const checked = (patch: RoutinePatch, now: Date) => Effect.try({ try: () => {
    const title = patch.title?.trim() ?? "";
    const instructions = patch.instructions?.trim() ?? "";
    const cron = patch.cron?.trim().replace(/\s+/g, " ") ?? "";
    const timezone = patch.timezone?.trim() || "UTC";
    if (!title || title.length > 120 || /[\x00-\x1f]/.test(title)) throw new Invalid("title is required (at most 120 characters, one line)");
    if (!instructions || instructions.length > 32_000) throw new Invalid("instructions are required (at most 32000 characters)");
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now); }
    catch { throw new Invalid("unknown IANA timezone"); }
    const problem = cronProblem(cron, timezone, ROUTINE_MIN_MINUTES, now);
    if (problem) throw new Invalid(problem);
    const next = nextCronRun(cron, timezone, now);
    if (!next) throw new Invalid("cron has no future runs");
    return { title, instructions, cron, timezone, next, schedule: cronstrue.toString(cron, { use24HourTimeFormat: true, throwExceptionOnParseError: true }) };
  }, catch: (e) => e instanceof Invalid ? e : new Invalid("invalid cron expression") });
  const update = (user: string, botId: string, id: string, patch: RoutinePatch, now: Date) => sql.withTransaction(Effect.gen(function* () {
    yield* hooks.owned(user, botId, true);
    const old = yield* get(botId, id);
    const c = yield* checked({ ...old, ...patch }, now);
    const enabled = patch.enabled ?? old.enabled;
    const timingChanged = c.cron !== old.cron || c.timezone !== old.timezone || enabled !== old.enabled;
    const r = (yield* sql<RoutineRow>`UPDATE bot_routines SET title = ${c.title}, instructions = ${c.instructions}, cron = ${c.cron}, timezone = ${c.timezone},
      schedule_text = ${c.schedule}, enabled = ${enabled}, next_run_at = ${enabled ? timingChanged ? c.next : old.next_run_at : null}, updated_at = now()
      WHERE id = ${id}::uuid RETURNING *`)[0]!;
    if (!enabled) yield* stop(id);
    yield* hooks.changed(botId);
    return routineView(r);
  }));
  return {
    routines: (user: string, botId: string) => Effect.gen(function* () { yield* hooks.owned(user, botId); return (yield* rows(botId)).map(routineView); }),
    createRoutine: (user: string, turn: BotTurn, id: string, patch: RoutinePatch, now: Date) => Effect.gen(function* () {
      yield* hooks.owned(user, turn.bot_id, true);
      if ((yield* rows(turn.bot_id)).length >= ROUTINE_LIMIT) return yield* Effect.fail(new Invalid(`at most ${ROUTINE_LIMIT} routines per bot`));
      const c = yield* checked(patch, now);
      const hops = yield* Effect.try({ try: () => nextHop(turn.hops), catch: () => new Invalid("Bot hop limit reached; a new user message is required") });
      const r = (yield* sql<RoutineRow>`INSERT INTO bot_routines(id, bot_id, title, instructions, cron, timezone, schedule_text, next_run_at, hops)
        VALUES (${id}::uuid, ${turn.bot_id}::uuid, ${c.title}, ${c.instructions}, ${c.cron}, ${c.timezone}, ${c.schedule}, ${c.next}, ${hops}) RETURNING *`)[0]!;
      yield* hooks.changed(turn.bot_id);
      return routineView(r);
    }),
    updateRoutine: update,
    deleteRoutine: (user: string, botId: string, id: string) => sql.withTransaction(Effect.gen(function* () {
      yield* hooks.owned(user, botId, true);
      yield* get(botId, id);
      yield* sql`UPDATE bot_routines SET deleted_at = now(), updated_at = now(), enabled = false, next_run_at = NULL WHERE id = ${id}::uuid`;
      yield* stop(id);
      yield* hooks.changed(botId);
      return { deleted: true };
    })),
    deliverRoutines: (user: string, now: Date) => sql.withTransaction(Effect.gen(function* () {
      // Claim and enqueue atomically. Advance from now: downtime coalesces to one occurrence.
      const dueBots = yield* sql<BotRow>`SELECT b.* FROM bots b WHERE b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM bot_routines r WHERE r.bot_id = b.id AND r.enabled AND r.deleted_at IS NULL AND r.next_run_at <= ${now})
        ORDER BY b.id FOR UPDATE SKIP LOCKED LIMIT 100`;
      for (const b of dueBots) {
        const due = yield* sql<RoutineRow>`SELECT * FROM bot_routines WHERE bot_id = ${b.id}::uuid AND enabled AND deleted_at IS NULL AND next_run_at <= ${now} ORDER BY id FOR UPDATE`;
        for (const r of due) {
          let next: Date | undefined;
          try { next = nextCronRun(r.cron, r.timezone, now); } catch { /* Disable an expression rejected after a parser upgrade. */ }
          const pending = yield* sql`SELECT id FROM bot_turns WHERE routine_id = ${r.id}::uuid AND status IN ('queued','running','waiting') LIMIT 1`;
          if (next && !pending.length) {
            const input = `Background routine: ${r.title}\nRoutine ID: ${r.id}\nScheduled for: ${new Date(r.next_run_at!).toISOString()}\nCurrent time: ${now.toISOString()} (${r.timezone})\nRun: ${r.run_count + 1}\nPrevious outcome: ${r.last_outcome || "No previous run"}`;
            yield* hooks.enqueue(user, b.id, input, `routine:${r.id}:${new Date(r.next_run_at!).toISOString()}`, { hops: r.hops, sender: "system", event: true, routineId: r.id, routineTitle: r.title });
            yield* sql`UPDATE bot_routines SET last_run_at = ${now}, run_count = run_count + 1, last_outcome = 'Running' WHERE id = ${r.id}::uuid`;
          }
          yield* sql`UPDATE bot_routines SET next_run_at = ${next ?? null}, enabled = ${Boolean(next)}, updated_at = now() WHERE id = ${r.id}::uuid`;
        }
        yield* hooks.changed(b.id);
      }
    })),
  };
}
