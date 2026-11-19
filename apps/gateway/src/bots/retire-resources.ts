import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { retireBotRoutes } from "../messengers/store-routes.ts";

/** Retire live references while preserving the bot, routine and conversation records for history. */
export function retireBotResources(sql: SqlClient.SqlClient, owner: string, botId: string) {
  return Effect.gen(function* () {
    yield* sql`UPDATE bot_routines SET enabled = false, deleted_at = now(), next_run_at = NULL, updated_at = now(),
      last_outcome = CASE WHEN last_outcome = 'Running' THEN 'Stopped' ELSE last_outcome END
      WHERE bot_id = ${botId}::uuid AND deleted_at IS NULL`;
    yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE bot_id = ${botId}::uuid AND NOT delivered AND NOT cancelled`;

    yield* sql`UPDATE computer_agent_calls SET detached = true,
      report_status = CASE WHEN report_status = 'pending' THEN 'dropped' ELSE report_status END
      WHERE owner_user_id = ${owner}::uuid AND NOT detached AND (
        (direction = 'outgoing' AND actor_kind = 'bot' AND actor_id = ${botId}::uuid)
        OR (direction = 'incoming' AND target_kind = 'bot' AND target_id = ${botId}::uuid))`;

    yield* sql`DELETE FROM bot_mcp_connections WHERE bot_id = ${botId}::uuid`;
    // Lock accounts before grants, as account deletion also removes its grants.
    yield* sql`SELECT a.id FROM connector_accounts a JOIN connector_bot_grants g ON g.account_id = a.id
      WHERE a.owner_user_id = ${owner}::uuid AND g.bot_id = ${botId}::uuid ORDER BY a.id FOR NO KEY UPDATE OF a`;
    yield* sql`WITH removed AS (
      DELETE FROM connector_bot_grants WHERE bot_id = ${botId}::uuid RETURNING account_id
    ) UPDATE connector_accounts SET revision = revision + 1, updated_at = now()
      WHERE owner_user_id = ${owner}::uuid AND id IN (SELECT account_id FROM removed)`;
    yield* retireBotRoutes(sql, owner, botId);
  });
}
