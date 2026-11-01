import { create, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { GoalStateSchema, ui, type GoalState } from "@open-agents/contracts";
import { goalStatusAfterFailure, goalStatusFromHarness, isFinished, type GoalStatus } from "@open-agents/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { NotFound, type TurnRow } from "./store.ts";

/**
 * Goals of the harness (docs/goals.md): the harness drives them, the gateway records what it reports
 * (goal_state events, applied by Ingest in the event's transaction) and what the user asked for in the UI.
 * At most one open goal per thread (goals_one_open).
 */

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound>;

export interface GoalRow {
  id: string;
  thread_id: string;
  objective: string;
  status: GoalStatus;
  created_by: string;
  token_budget: bigint | string | null;
  tokens_used: bigint | string;
  time_used_seconds: number;
  turns_used: number;
  last_reason: string | null;
  native_status: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  /** The last goal command failed on the worker (cleared by the next one). */
  error: string | null;
  error_at: Date | null;
}

export function toUiGoal(row: GoalRow): ui.Goal {
  return create(ui.GoalSchema, {
    id: row.id,
    threadId: row.thread_id,
    objective: row.objective,
    status: row.status,
    createdBy: row.created_by,
    tokenBudget: BigInt(row.token_budget ?? 0),
    tokensUsed: BigInt(row.tokens_used),
    timeUsedSeconds: BigInt(row.time_used_seconds),
    iterations: row.turns_used,
    lastReason: row.last_reason ?? "",
    nativeStatus: row.native_status ?? "",
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    ...(row.finished_at && { finishedAt: timestampFromDate(new Date(row.finished_at)) }),
    error: row.error ?? "",
    ...(row.error_at && { errorAt: timestampFromDate(new Date(row.error_at)) }),
  });
}

/** Open goal first, else the most recently created one. */
const latestGoal = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<GoalRow>`
    SELECT * FROM goals WHERE thread_id = ${threadId}::uuid
     ORDER BY (status NOT IN ('achieved', 'cancelled')) DESC, created_at DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]));

/** Objectives compared as the harness may echo them (trimmed, whitespace collapsed). */
const sameObjective = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

/**
 * Applies a harness report to the thread's goals, inside the ingest transaction. Returns the goal it changed.
 *
 * - The goal the report belongs to: the open one when the report's turn works for it or the objective matches;
 *   a different objective means the harness set a new goal itself (created_by = provider), replacing the open one.
 * - The status follows the harness, except that a pause or clear the user asked for is kept (goalStatusFromHarness).
 * - Usage as the harness counts it; iterations = Codex continuation turns, Claude evaluator checks.
 */
export const applyGoalState = (sql: SqlClient.SqlClient, threadId: string, turnId: string, state: GoalState) =>
  Effect.gen(function* () {
    const thread = (yield* sql<{ provider: string }>`SELECT provider FROM threads WHERE id = ${threadId}::uuid`)[0];
    if (!thread) return undefined;
    const provider = thread.provider === "claude" ? "claude" : "codex";
    const cleared = state.cleared || state.nativeStatus === "cleared";
    const open = (yield* sql<GoalRow>`
      SELECT * FROM goals WHERE thread_id = ${threadId}::uuid AND status NOT IN ('achieved', 'cancelled') FOR UPDATE`)[0];
    const turnGoal = turnId ? (yield* sql<{ goal_id: string | null }>`SELECT goal_id FROM turns WHERE id = ${turnId}::uuid`)[0]?.goal_id : undefined;
    let goal = open && (cleared || !state.objective || turnGoal === open.id || sameObjective(open.objective, state.objective)) ? open : undefined;
    if (!goal && !open) {
      // Late reports of a goal that already ended update it: Codex usage after complete, or the harness
      // confirming a clear the user asked for (the goal was closed when they asked).
      const latest = yield* latestGoal(sql, threadId);
      if (latest && ((cleared && !state.objective) || sameObjective(latest.objective, state.objective))) goal = latest;
    }
    if (!goal) {
      if (cleared || !state.objective) return undefined;
      if (open) {
        yield* sql`UPDATE goals SET status = 'cancelled', last_reason = 'replaced by a new goal', finished_at = now(), updated_at = now() WHERE id = ${open.id}::uuid`;
      }
      const id = Bun.randomUUIDv7();
      yield* sql`
        INSERT INTO goals (id, thread_id, objective, status, created_by, native_status)
        VALUES (${id}::uuid, ${threadId}::uuid, ${state.objective}, 'active', 'provider', ${state.nativeStatus || null})`;
      goal = (yield* sql<GoalRow>`SELECT * FROM goals WHERE id = ${id}::uuid`)[0]!;
    }
    // A finished goal stays finished: late reports only update its usage.
    const status = isFinished(goal.status) ? goal.status : goalStatusFromHarness(provider, state.nativeStatus, cleared, goal.status);
    if (turnId) yield* sql`UPDATE turns SET goal_id = ${goal.id}::uuid WHERE id = ${turnId}::uuid AND thread_id = ${threadId}::uuid AND goal_id IS NULL`;
    const turns =
      provider === "codex"
        ? Number((yield* sql<{ n: string }>`SELECT count(*) AS n FROM turns WHERE goal_id = ${goal.id}::uuid AND trigger = 'provider'`)[0]?.n ?? 0)
        : Math.max(goal.turns_used, state.iterations);
    const native = JSON.stringify(toJson(GoalStateSchema, state) as JsonValue);
    yield* sql`
      UPDATE goals SET status = ${status},
                       native_status = ${cleared ? "cleared" : state.nativeStatus || goal.native_status},
                       native_state = ${native}::jsonb,
                       tokens_used = greatest(tokens_used, ${state.tokensUsed}),
                       time_used_seconds = greatest(time_used_seconds, ${Number(state.timeUsedSeconds)}),
                       token_budget = coalesce(${state.tokenBudget > 0n ? state.tokenBudget : null}, token_budget),
                       turns_used = ${turns},
                       last_reason = coalesce(${state.lastReason || null}, last_reason),
                       finished_at = CASE WHEN ${status} IN ('achieved', 'cancelled') THEN coalesce(finished_at, now()) ELSE NULL END,
                       updated_at = now()
       WHERE id = ${goal.id}::uuid`;
    return goal.id;
  });

export class GoalStore extends Context.Service<
  GoalStore,
  {
    /** Open goal, else the most recent one; undefined when the thread never had a goal. */
    latest(threadId: string): Fx<GoalRow | undefined>;
    goal(goalId: string): Fx<GoalRow>;
    /** A goal the user set: replaces the open one (cancelled). */
    create(input: { threadId: string; objective: string; tokenBudget: bigint; userId: string }): Fx<GoalRow>;
    /** The user's pause, resume or clear (a new command: the last one's error goes). */
    setStatus(goalId: string, status: GoalStatus): Fx<GoalRow>;
    /**
     * A goal command (SetGoal) failed on the worker: the error is kept and the status goes back to what the
     * harness last reported (goalStatusAfterFailure), unless another goal of the thread is open by now.
     */
    commandFailed(goalId: string, error: string): Fx<GoalRow>;
    /** A Claude goal turn (/goal …) could not start: the error is kept on the turn's goal (no status rollback). */
    turnFailed(turnId: string, error: string): Fx<GoalRow | undefined>;
    /** The harness took the command: a previous error goes. Undefined when there was none. */
    commandSucceeded(goalId: string): Fx<GoalRow | undefined>;
    /** Claude: /goal as a queued turn of the goal. */
    enqueueGoalTurn(input: { threadId: string; goalId: string; text: string }): Fx<TurnRow>;
  }
>()("open-agents/gateway/GoalStore") {
  static readonly layer = Layer.effect(
    GoalStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const goal = (goalId: string) =>
        sql<GoalRow>`SELECT * FROM goals WHERE id = ${goalId}::uuid`.pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("goal not found")))),
        );
      return GoalStore.of({
        latest: (threadId) => latestGoal(sql, threadId),
        goal,
        create: ({ threadId, objective, tokenBudget, userId }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE goals SET status = 'cancelled', last_reason = 'replaced by a new goal', finished_at = now(), updated_at = now()
                 WHERE thread_id = ${threadId}::uuid AND status NOT IN ('achieved', 'cancelled')`;
              const id = Bun.randomUUIDv7();
              yield* sql`
                INSERT INTO goals (id, thread_id, objective, status, created_by, created_by_user_id, token_budget)
                VALUES (${id}::uuid, ${threadId}::uuid, ${objective}, 'active', 'user', ${userId}::uuid, ${tokenBudget > 0n ? tokenBudget : null})`;
              return yield* goal(id);
            }),
          ),
        setStatus: (goalId, status) =>
          sql`
            UPDATE goals SET status = ${status}, updated_at = now(), error = NULL, error_at = NULL,
                             finished_at = CASE WHEN ${status} IN ('achieved', 'cancelled') THEN coalesce(finished_at, now()) ELSE NULL END
             WHERE id = ${goalId}::uuid`.pipe(Effect.flatMap(() => goal(goalId))),
        commandFailed: (goalId, error) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* goal(goalId);
              const thread = (yield* sql<{ provider: string }>`SELECT provider FROM threads WHERE id = ${current.thread_id}::uuid`)[0];
              const target = goalStatusAfterFailure(thread?.provider === "claude" ? "claude" : "codex", current.native_status ?? "");
              const other = yield* sql`
                SELECT 1 FROM goals WHERE thread_id = ${current.thread_id}::uuid AND id <> ${goalId}::uuid AND status NOT IN ('achieved', 'cancelled')`;
              const status = isFinished(target) || other.length === 0 ? target : current.status;
              yield* sql`
                UPDATE goals SET status = ${status}, error = ${error}, error_at = now(), updated_at = now(),
                                 finished_at = CASE WHEN ${status} IN ('achieved', 'cancelled') THEN coalesce(finished_at, now()) ELSE NULL END
                 WHERE id = ${goalId}::uuid`;
              return yield* goal(goalId);
            }),
          ),
        turnFailed: (turnId, error) =>
          sql<GoalRow>`
            UPDATE goals SET error = ${error}, error_at = now(), updated_at = now()
             WHERE id = (SELECT goal_id FROM turns WHERE id = ${turnId}::uuid)
            RETURNING *`.pipe(Effect.map((rows) => rows[0])),
        commandSucceeded: (goalId) =>
          sql<GoalRow>`
            UPDATE goals SET error = NULL, error_at = NULL, updated_at = now() WHERE id = ${goalId}::uuid AND error IS NOT NULL
            RETURNING *`.pipe(Effect.map((rows) => rows[0])),
        enqueueGoalTurn: ({ threadId, goalId, text }) =>
          sql<TurnRow>`
            INSERT INTO turns (id, thread_id, ordinal, trigger, goal_id, input)
            SELECT ${Bun.randomUUIDv7()}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'goal', ${goalId}::uuid, ${JSON.stringify({ text })}::jsonb
              FROM turns WHERE thread_id = ${threadId}::uuid
            RETURNING *`.pipe(Effect.map((rows) => rows[0]!)),
      });
    }),
  );
}
