import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { BOT_THREADS_DISCONNECTED } from "../store/module-access.ts";
import { threadToolNames } from "./thread-tools.ts";

/** Run in the preference transaction so old watches and approval cards cannot revive on re-enable. */
export function disconnectBotThreads(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    yield* sql`UPDATE bot_thread_watches w SET delivered = true FROM bots b
      WHERE w.bot_id = b.id AND b.owner_user_id = ${owner}::uuid AND NOT w.delivered`;
    yield* sql`UPDATE computer_agent_calls SET report_status = 'dropped' WHERE owner_user_id = ${owner}::uuid
      AND report_status = 'pending' AND actor_kind <> coalesce(target_kind, 'thread')`;
    yield* sql`WITH expired AS (
      UPDATE bot_approvals a SET status = 'expired', answered_at = now() FROM bot_tool_calls c, bots b
      WHERE a.id = c.id AND b.id = a.bot_id AND b.owner_user_id = ${owner}::uuid
        AND a.status = 'pending' AND c.tool ->> 'source' = 'platform'
        AND (c.tool ->> 'name' = ANY(${[...threadToolNames]}::text[])
          OR (c.tool ->> 'name' = 'cancel_schedule' AND NOT EXISTS (SELECT 1 FROM bot_wakeups w
              WHERE w.bot_id = b.id AND w.id::text = c.arguments ->> 'schedule_id')))
      RETURNING a.id, a.turn_id, a.bot_id
    ), interrupted AS (
      UPDATE bot_tool_calls SET status = 'interrupted', result = jsonb_build_object('error', ${BOT_THREADS_DISCONNECTED}::text)
      WHERE status = 'pending' AND id IN (SELECT id FROM expired)
    ), resumed AS (
      UPDATE bot_turns SET status = 'queued' WHERE status = 'waiting' AND id IN (SELECT turn_id FROM expired)
    ) UPDATE bots SET revision = revision + 1, updated_at = now() WHERE id IN (SELECT bot_id FROM expired)`;
  });
}
