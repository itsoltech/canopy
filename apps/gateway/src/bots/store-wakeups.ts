import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import { nextHop } from "./policy.ts";
import { originOf } from "./routines.ts";
import type { BotTurn, StoredCall } from "./types.ts";
import { requiredString, type WakeupRow } from "./store-views.ts";
import type { BotCore } from "./store-queue.ts";

/** Watches of threads and steers, wakeups and reminders. */
export function botWakeups(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, changed } = core;

  return {
    watchThread: (turn: BotTurn, call: StoredCall, threadId: string, turnId: string) =>
      Effect.gen(function* () {
        const hop = nextHop(turn.hops);
        const replyHop = nextHop(hop);
        yield* sql`UPDATE turns SET trigger = 'bot', author_user_id = NULL, bot_call_id = ${call.id}::uuid, hops = ${hop} WHERE id = ${turnId}::uuid AND status = 'queued'`;
        yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops)
        VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${threadId}::uuid, ${turnId}::uuid, ${replyHop}) ON CONFLICT(call_id) DO NOTHING`;
      }),
    watchSteer: (turn: BotTurn, call: StoredCall, threadId: string, steerId: string) =>
      Effect.gen(function* () {
        const hops = nextHop(turn.hops);
        const replyHops = nextHop(hops);
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
  const { changed, enqueue, originEnabled } = core;

  return {
    deliver: () =>
      sql.withTransaction(
        Effect.gen(function* () {
          const steers = yield* sql<{
            call_id: string;
            target_turn_id: string;
          }>`SELECT w.call_id, CASE WHEN s.status = 'delivered' THEN s.turn_id ELSE s.queued_turn_id END AS target_turn_id
        FROM bot_thread_watches w JOIN turn_steers s ON w.target_steer_id = s.id JOIN bots b ON b.id = w.bot_id
        WHERE NOT w.delivered AND w.target_turn_id IS NULL AND s.status IN ('delivered','queued') AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF b, w SKIP LOCKED`;

          for (const steer of steers)
            yield* sql`UPDATE bot_thread_watches SET target_turn_id = ${steer.target_turn_id}::uuid WHERE call_id = ${steer.call_id}::uuid`;

          const watches = yield* sql<{
            call_id: string;
            bot_id: string;
            target_thread_id: string;
            target_turn_id: string;
            hops: number;
            owner_user_id: string;
            status: string;
            title: string;
          }>`SELECT w.*, b.owner_user_id, t.status, th.title FROM bot_thread_watches w
        JOIN bots b ON b.id = w.bot_id JOIN turns t ON t.id = w.target_turn_id JOIN threads th ON th.id = t.thread_id
        WHERE NOT w.delivered AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL AND th.owner_user_id = b.owner_user_id AND t.status IN ('completed','failed','interrupted','cancelled') FOR UPDATE OF b, w SKIP LOCKED`;

          for (const watch of watches) {
            const items = yield* sql<{
              content: { agentMessage?: { text?: string } };
            }>`SELECT content FROM thread_items WHERE thread_id = ${watch.target_thread_id}::uuid AND turn_id = ${watch.target_turn_id}::uuid ORDER BY first_seq`;

            const text = items
              .map((i) => i.content.agentMessage?.text ?? "")
              .filter(Boolean)
              .join("\n")
              .slice(0, 80_000);

            const source =
              (yield* sql<BotTurn>`SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE c.id = ${watch.call_id}::uuid`)[0];

            if (yield* originEnabled(source))
              yield* enqueue(
                watch.owner_user_id,
                watch.bot_id,
                `Thread ${watch.title} (${watch.target_thread_id}) ended: ${watch.status}.\n${text}`,
                `thread:${watch.call_id}`,
                { hops: watch.hops, sender: watch.target_thread_id, event: true, ...originOf(source) },
              );
            yield* sql`UPDATE bot_thread_watches SET delivered = true WHERE call_id = ${watch.call_id}::uuid`;
          }

          const wakeups = yield* sql<{
            id: string;
            bot_id: string;
            prompt: string;
            hops: number;
            owner_user_id: string;
          }>`SELECT w.*, b.owner_user_id FROM bot_wakeups w JOIN bots b ON b.id = w.bot_id
        WHERE NOT w.delivered AND NOT w.cancelled AND w.run_at <= now() AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF b, w SKIP LOCKED`;

          for (const wake of wakeups) {
            const source =
              (yield* sql<BotTurn>`SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE c.id = ${wake.id}::uuid`)[0];

            if (yield* originEnabled(source))
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
