import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BotTurn } from "./types.ts";
import type { BotCore } from "./store-queue.ts";
import { originOf } from "./routines.ts";
import { botThreadNoticeTitle } from "./thread-notice.ts";

export const pendingThreadQuestions = (sql: SqlClient.SqlClient) => sql`
  FROM bot_thread_watches w
  JOIN bots b ON b.id = w.bot_id
  JOIN threads th ON th.id = w.target_thread_id AND th.owner_user_id = b.owner_user_id
  JOIN interaction_requests q ON q.thread_id = th.id AND q.turn_id = w.target_turn_id
  WHERE NOT w.delivered AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
    AND q.status = 'pending' AND q.kind IN ('question', 'elicitation')
    AND NOT EXISTS (
      SELECT 1 FROM bot_thread_question_deliveries d WHERE d.call_id = w.call_id AND d.request_id = q.id
    )`;

export const deliverySources = (sql: SqlClient.SqlClient, ids: readonly string[]) =>
  ids.length
    ? sql<BotTurn & { call_id: string; origin_enabled: boolean }>`SELECT t.*,c.id AS call_id,
    (t.routine_id IS NULL OR coalesce(r.enabled AND r.deleted_at IS NULL,false)) AS origin_enabled
    FROM bot_tool_calls c JOIN bot_turns t ON t.id=c.turn_id LEFT JOIN bot_routines r ON r.id=t.routine_id
    WHERE c.id=ANY(${[...ids]}::uuid[])`.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.call_id, row]))))
    : Effect.succeed(new Map<string, BotTurn & { origin_enabled: boolean }>());

export const deliverThreadQuestions = (sql: SqlClient.SqlClient, core: BotCore, owner: string) =>
  Effect.gen(function* () {
    const questions = yield* sql<{
      call_id: string;
      bot_id: string;
      owner_user_id: string;
      thread_id: string;
      request_id: string;
      title: string;
      hops: number;
    }>`SELECT w.call_id, w.bot_id, b.owner_user_id, th.id AS thread_id, q.id AS request_id, th.title, w.hops
      ${pendingThreadQuestions(sql)} AND b.owner_user_id=${owner}::uuid
      ORDER BY q.created_at, q.id, w.call_id LIMIT 32 FOR UPDATE OF b, w SKIP LOCKED`;

    const sources = yield* deliverySources(
      sql,
      questions.map((q) => q.call_id),
    );

    for (const q of questions) {
      const source = sources.get(q.call_id);

      const receipt = yield* sql`INSERT INTO bot_thread_question_deliveries(call_id, request_id)
        VALUES (${q.call_id}::uuid, ${q.request_id}::uuid) ON CONFLICT DO NOTHING RETURNING request_id`;

      if (!receipt.length || !(source?.origin_enabled ?? true) || !(yield* core.originEnabled(source))) continue;
      const title = botThreadNoticeTitle(q.title);

      yield* core.enqueue(
        q.owner_user_id,
        q.bot_id,
        `Thread "${title}" (thread_id: ${q.thread_id}) is waiting for input (request_id: ${q.request_id}).\nUse read_thread to see the request. The user can answer it in Canopy or approve your answer_interaction call.`,
        `thread-question:${q.call_id}:${q.request_id}`,
        {
          hops: q.hops,
          sender: q.thread_id,
          event: true,
          displayText: `“${title}” needs input`,
          ...originOf(source),
        },
      );
    }
  });
