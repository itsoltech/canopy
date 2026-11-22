import { DEFAULT_BUS_LIMITS } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { insertCall, turnRef } from "../store/agent-bus-queries.ts";
import type { CallSource } from "../store/agent-bus-types.ts";
import { BOT_THREADS_DISCONNECTED, lockedBotThreadConnection } from "../store/module-access.ts";
import { Invalid } from "../store/store.ts";
import { DISPATCHED } from "../store/turn-select.ts";
import { canReportBotTurn } from "./report-origin.ts";
import { originOf } from "./routines.ts";
import type { BotCore } from "./store-queue.ts";
import { botThreadNoticeTitle } from "./thread-notice.ts";
import type { BotTurn } from "./types.ts";

type Origin = Pick<BotTurn, "bot_id" | "routine_id" | "routine_title" | "conversation_id" | "hops">;

/** A steer belongs to its running turn only once the worker confirms entry. A fallback owns its queued turn. */
function delegationOrigins(sql: SqlClient.SqlClient, source: CallSource) {
  return sql<Origin>`SELECT bt.bot_id, bt.conversation_id, bt.routine_id, max(bt.routine_title) AS routine_title,
      max(w.hops) AS hops
    FROM bot_thread_watches w JOIN bot_tool_calls c ON c.id=w.call_id
    JOIN bot_turns bt ON bt.id=c.turn_id AND bt.bot_id=w.bot_id
    LEFT JOIN turn_steers s ON s.id=w.target_steer_id AND s.thread_id=w.target_thread_id
    WHERE w.target_thread_id=${source.threadId}::uuid AND NOT w.delivered
      AND (CASE WHEN w.target_steer_id IS NULL THEN w.target_turn_id
            WHEN s.status='delivered' THEN s.turn_id WHEN s.status='queued' THEN s.queued_turn_id END)=${source.turnId}::uuid
    GROUP BY bt.bot_id, bt.conversation_id, bt.routine_id LIMIT 2`;
}

function linkedBotInput(sql: SqlClient.SqlClient, owner: string, source: CallSource) {
  return sql`SELECT 1 FROM computer_agent_calls c
    LEFT JOIN turn_steers s ON s.id=c.target_steer_id AND s.thread_id=c.target_id
    WHERE c.owner_user_id=${owner}::uuid AND c.direction='incoming' AND c.actor_kind='bot'
      AND c.target_kind='thread' AND c.target_id=${source.threadId}::uuid AND c.notify
      AND NOT c.detached AND c.report_status='pending'
      AND (CASE WHEN c.target_steer_id IS NULL THEN c.target_turn_id
           WHEN s.status='delivered' THEN s.turn_id WHEN s.status='queued' THEN s.queued_turn_id END)=${source.turnId}::uuid
    LIMIT 1`;
}

export function messageDelegatingBot(
  sql: SqlClient.SqlClient,
  core: BotCore,
  owner: string,
  source: CallSource,
  text: string,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockedBotThreadConnection(sql, owner)))
        return yield* Effect.fail(new Invalid(BOT_THREADS_DISCONNECTED));

      // Lock bot first, as bot actions do. Lifecycle and module changes cannot race admission.
      const creator = (yield* sql<{ bot_id: string }>`SELECT b.id AS bot_id
        FROM bot_started_threads d JOIN bots b ON b.id=d.bot_id
        WHERE d.thread_id=${source.threadId}::uuid AND b.owner_user_id=${owner}::uuid
          AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF b`)[0];

      if (!creator) return yield* Effect.fail(new Invalid("This thread has no active delegating bot."));

      const turn = (yield* sql<{
        hops: number;
        title: string;
      }>`SELECT u.hops, t.title FROM threads t JOIN turns u ON u.thread_id=t.id
        WHERE t.id=${source.threadId}::uuid AND t.owner_user_id=${owner}::uuid AND u.id=${turnRef(sql, source)}
        AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.rewind_pending_id IS NULL
        AND u.rewind_id IS NULL AND (u.status='running' OR (u.status='queued' AND ${sql.literal(DISPATCHED)}))
        FOR UPDATE OF t, u`)[0];

      if (!turn) return yield* Effect.fail(new Invalid("Only the current turn can message its delegating bot."));

      const origins = yield* delegationOrigins(sql, source);
      const origin = origins[0];

      if (!origin)
        return yield* Effect.fail(new Invalid("The bot that started this thread is not watching this turn."));

      if (origins.length > 1 || (yield* linkedBotInput(sql, owner, source)).length)
        return yield* Effect.fail(new Invalid("This turn has multiple bot message origins."));

      if (origin.conversation_id) {
        const safe =
          yield* sql`SELECT 1 WHERE ${canReportBotTurn(sql, sql`${source.threadId}::uuid`, sql`${source.turnId}::uuid`)}`;

        if (!safe.length) return yield* Effect.fail(new Invalid("This turn has multiple message origins."));
      }

      if (origin.bot_id !== creator.bot_id)
        return yield* Effect.fail(new Invalid("This turn was delegated by a different bot."));

      // The watch reserves its return hop. A steer may have entered a turn deeper in another chain.
      const hops = Math.max(turn.hops + 1, origin.hops);

      if (hops > DEFAULT_BUS_LIMITS.maxHops)
        return yield* Effect.fail(new Invalid("This automated conversation reached its step limit."));

      const title = botThreadNoticeTitle(turn.title);

      const turnId = yield* core.enqueue(
        owner,
        creator.bot_id,
        `Message from the running thread "${title}" (thread_id: ${source.threadId}):\n${text}`,
        `thread-message:${source.callId}`,
        { hops, sender: source.threadId, event: true, displayText: text, ...originOf(origin) },
      );

      const result = { bot_id: creator.bot_id, turn_id: turnId, delivery: "queue" };

      yield* insertCall(sql, { source, tool: "message_delegating_bot", args: { text }, status: "completed", result });

      return result;
    }),
  );
}
