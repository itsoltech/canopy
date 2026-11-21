import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import { nextHop, nextReplyHop } from "./policy.ts";
import { originOf } from "./routines.ts";
import type { BotTurn, StoredCall } from "./types.ts";
import { requiredString, type WakeupRow } from "./store-views.ts";
import type { BotCore } from "./store-queue.ts";
import { lockedOwnerModule } from "../store/module-access.ts";
import { deliverThreadQuestions, deliverySources } from "./thread-questions.ts";
import { turnReport } from "../store/turn-report.ts";
import { canReportBotTurn } from "./report-origin.ts";
import { botThreadNoticeTitle, threadNotice } from "./thread-notice.ts";
import { watchCompletion, watchNeedsCheck } from "./watch-completion.ts";

/** Watches of threads and steers, wakeups and reminders. */
export function botWakeups(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, changed } = core;

  return {
    watchThread: (turn: BotTurn, call: StoredCall, threadId: string, turnId: string) =>
      Effect.gen(function* () {
        const hop = nextHop(turn.hops);
        const replyHop = nextReplyHop(turn.hops);
        yield* sql`UPDATE turns SET trigger = 'bot', author_user_id = NULL, bot_call_id = ${call.id}::uuid, hops = ${hop} WHERE id = ${turnId}::uuid AND status = 'queued'`;
        yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops)
        VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${threadId}::uuid, ${turnId}::uuid, ${replyHop}) ON CONFLICT(call_id) DO NOTHING`;
      }),
    watchSteer: (turn: BotTurn, call: StoredCall, threadId: string, steerId: string) =>
      Effect.gen(function* () {
        const hops = nextHop(turn.hops);
        const replyHops = nextReplyHop(turn.hops);
        yield* sql`UPDATE turn_steers SET bot_call_id = ${call.id}::uuid, author_user_id = NULL, hops = ${hops} WHERE id = ${steerId}::uuid`;
        yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_steer_id, hops)
        VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${threadId}::uuid, ${steerId}::uuid, ${replyHops}) ON CONFLICT(call_id) DO NOTHING`;
      }),
    wakeup: (turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const runAt = new Date(requiredString(call.arguments, "run_at", 100));

        if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now())
          return yield* Effect.fail(new Invalid("run_at must be in the future"));
        yield* sql`INSERT INTO bot_wakeups(id, bot_id, prompt, run_at, hops) VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${requiredString(call.arguments, "prompt")}, ${runAt}, ${nextHop(turn.hops)}) ON CONFLICT(id) DO NOTHING`;
        yield* changed(turn.bot_id);

        return { schedule_id: call.id };
      }),
    wakeups: (botId: string) =>
      sql<WakeupRow>`SELECT id, prompt, run_at, cancelled, delivered FROM bot_wakeups WHERE bot_id = ${botId}::uuid ORDER BY run_at`,
    cancelReminder: (user: string, botId: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, botId, true);

          const r =
            yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE id = ${id}::uuid AND bot_id = ${botId}::uuid AND NOT delivered RETURNING id`;

          if (!r.length) return yield* Effect.fail(new NotFound("reminder not found"));
          yield* changed(botId);
        }),
      ),
    cancelWakeup: (botId: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const r =
            yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE id = ${id}::uuid AND bot_id = ${botId}::uuid RETURNING id`;

          yield* changed(botId);

          return { cancelled: r.length > 0 };
        }),
      ),
  };
}

/** Delivers due watches and wakeups as bot turns. */
export function botDeliveries(sql: SqlClient.SqlClient, core: BotCore) {
  const { changed, enqueue } = core;

  return {
    deliver: (owner: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return;

          const steers = yield* sql<{
            call_id: string;
            target_turn_id: string;
          }>`SELECT w.call_id, CASE WHEN s.status = 'delivered' THEN s.turn_id ELSE s.queued_turn_id END AS target_turn_id
        FROM bot_thread_watches w JOIN turn_steers s ON w.target_steer_id = s.id JOIN bots b ON b.id = w.bot_id
        WHERE b.owner_user_id=${owner}::uuid AND NOT w.delivered AND w.target_turn_id IS NULL AND s.status IN ('delivered','queued') AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL ORDER BY w.call_id LIMIT 32 FOR UPDATE OF b, w SKIP LOCKED`;

          for (const steer of steers)
            yield* sql`UPDATE bot_thread_watches SET target_turn_id = ${steer.target_turn_id}::uuid WHERE call_id = ${steer.call_id}::uuid`;

          yield* deliverThreadQuestions(sql, core, owner);

          const watches = yield* sql<{
            call_id: string;
            bot_id: string;
            target_thread_id: string;
            target_turn_id: string;
            result_turn_id: string;
            incomplete: boolean;
            last_seq: string;
            check_at: Date | null;
            hops: number;
            owner_user_id: string;
            status: string;
            error: string | null;
            title: string;
          }>`SELECT w.*, b.owner_user_id, th.title, th.last_seq, continuation.check_at,
        coalesce(continuation.id,t.id) AS result_turn_id,
        coalesce(continuation.status,t.status) AS status,
        CASE WHEN continuation.id IS NULL THEN t.error ELSE continuation.error END AS error,
        continuation.incomplete IS TRUE AS incomplete
        FROM bot_thread_watches w
        JOIN bots b ON b.id = w.bot_id JOIN turns t ON t.id = w.target_turn_id JOIN threads th ON th.id = t.thread_id
        ${watchCompletion(sql)}
        WHERE b.owner_user_id=${owner}::uuid AND NOT w.delivered AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
          AND th.owner_user_id = b.owner_user_id AND t.status IN ('completed','failed','interrupted','cancelled')
          AND ${watchNeedsCheck(sql)} ORDER BY w.call_id LIMIT 32 FOR UPDATE OF b, w SKIP LOCKED`;

          for (const watch of watches) {
            if (!watch.check_at) continue;
            yield* sql`UPDATE bot_thread_watches SET continuation_checked_seq=${watch.last_seq}::bigint,
              continuation_check_at=${watch.check_at} WHERE call_id=${watch.call_id}::uuid`;
          }

          const finished = watches.filter((w) => w.check_at === null);

          const watchSources = yield* deliverySources(
            sql,
            finished.map((w) => w.call_id),
          );

          const results = yield* watchTexts(
            sql,
            finished.map((w) => ({
              call: w.call_id,
              thread: w.target_thread_id,
              turn: w.result_turn_id,
              root: w.target_turn_id,
            })),
          );

          for (const watch of finished) {
            const text = results.get(watch.call_id);
            const source = watchSources.get(watch.call_id);

            if (text !== undefined && (source?.origin_enabled ?? true) && (yield* core.originEnabled(source))) {
              const title = botThreadNoticeTitle(watch.title);
              const { message, failure } = turnReport(watch.status, watch.error, text, 80_000);

              yield* enqueue(
                watch.owner_user_id,
                watch.bot_id,
                watch.incomplete
                  ? `Thread ${title} (${watch.target_thread_id}): the last confirmed turn ended as ${watch.status}. A background follow-up could not be confirmed.\n${message}`
                  : `Thread ${title} (${watch.target_thread_id}) ended: ${watch.status}.\n${message}`,
                `thread:${watch.call_id}`,
                {
                  hops: watch.hops,
                  sender: watch.target_thread_id,
                  event: true,
                  displayText: watch.incomplete
                    ? `“${title}” has a partial result`
                    : threadNotice(title, watch.status, "", failure),
                  ...originOf(source),
                },
              );
            }

            yield* sql`UPDATE bot_thread_watches SET delivered = true WHERE call_id = ${watch.call_id}::uuid`;
          }

          const wakeups = yield* sql<{
            id: string;
            bot_id: string;
            prompt: string;
            hops: number;
            owner_user_id: string;
          }>`SELECT w.*, b.owner_user_id FROM bot_wakeups w JOIN bots b ON b.id = w.bot_id
        WHERE b.owner_user_id=${owner}::uuid AND NOT w.delivered AND NOT w.cancelled AND w.run_at <= now() AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL ORDER BY w.run_at,w.id LIMIT 32 FOR UPDATE OF b, w SKIP LOCKED`;

          const wakeSources = yield* deliverySources(
            sql,
            wakeups.map((w) => w.id),
          );

          for (const wake of wakeups) {
            const source = wakeSources.get(wake.id);

            if ((source?.origin_enabled ?? true) && (yield* core.originEnabled(source)))
              yield* enqueue(wake.owner_user_id, wake.bot_id, wake.prompt, `wakeup:${wake.id}`, {
                hops: wake.hops,
                sender: "system",
                event: true,
                ...originOf(source),
              });
            yield* sql`UPDATE bot_wakeups SET delivered = true WHERE id = ${wake.id}::uuid`;
            yield* changed(wake.bot_id);
          }
        }),
      ),
  };
}

/** Fetch a text prefix, never complete tool payloads. JS slicing retains the historical UTF-16 limit. */
const watchTexts = (
  sql: SqlClient.SqlClient,
  requested: readonly { call: string; thread: string; turn: string; root: string }[],
) =>
  sql<{
    call: string;
    text: string;
  }>`SELECT r.call,result.text FROM unnest(${requested.map((r) => r.call)}::uuid[],
    ${requested.map((r) => r.thread)}::uuid[],${requested.map((r) => r.turn)}::uuid[],${requested.map((r) => r.root)}::uuid[]) r(call,thread,turn,root)
  CROSS JOIN LATERAL (WITH texts AS MATERIALIZED (
    SELECT first_seq,left(content->'agentMessage'->>'text',80000) AS text FROM thread_items
    WHERE thread_id=r.thread AND turn_id=r.turn AND type='agent_message'
      AND coalesce(content->'agentMessage'->>'text','')<>''
  ), budget AS (
    SELECT first_seq,text,coalesce(sum(length(text)+1) OVER(ORDER BY first_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding FROM texts
  ) SELECT left(coalesce(string_agg(text,E'\n' ORDER BY first_seq) FILTER(WHERE preceding<=80000),''),80000) AS text FROM budget) result
  WHERE ${canReportBotTurn(sql, sql`r.thread`, sql`r.turn`)}
    AND (r.root=r.turn OR ${canReportBotTurn(sql, sql`r.thread`, sql`r.root`, true)})`.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.call, row.text.slice(0, 80000)]))),
  );
