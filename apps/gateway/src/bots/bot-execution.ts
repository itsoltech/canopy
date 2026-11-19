import type { SqlClient } from "effect/sql";
import { activeConversationSource } from "../messengers/conversation-access.ts";
import { ownerModule } from "../store/module-access.ts";

export interface BotExecution {
  bot_id: string;
  worker_id: string;
  instance_id: string;
  epoch: bigint;
}

export function botExecutions(sql: SqlClient.SqlClient, owner: string) {
  // Hello may advertise a terminal event; wait for its replay before trusting that journal's earlier start.
  return sql<BotExecution>`SELECT b.id AS bot_id, h.worker_id, l.instance_id, l.epoch
    FROM bot_turns t JOIN bots b ON b.id=t.bot_id
    JOIN bot_harness_turns h ON h.turn_id=t.id AND h.bot_id=b.id
    JOIN bot_harness_cursors j ON j.worker_id=h.worker_id AND j.bot_id=b.id AND j.journal_id=h.started_journal_id
    JOIN workers w ON w.id=h.worker_id
    JOIN worker_connections l ON l.worker_id=w.id AND l.bot_journal_id=h.started_journal_id
    JOIN worker_commands c ON c.id=h.command_id
    WHERE b.owner_user_id=${owner}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
      AND ${ownerModule(sql, owner, "bots")}
      AND w.revoked_at IS NULL AND w.archived_at IS NULL
      AND l.bot_presence_until>now()
      AND j.last_seq>=coalesce((l.bot_journal_pending->>b.id::text)::numeric,0)
      AND t.status='running' AND t.lease_token IS NOT NULL AND t.lease_until>now()
      AND h.outcome IS NULL AND c.status NOT IN ('failed','expired')
      AND NOT EXISTS (SELECT 1 FROM bot_approvals a WHERE a.bot_id=b.id AND a.turn_id=t.id AND a.status='pending')
      AND (t.conversation_id IS NULL OR EXISTS (SELECT 1 ${activeConversationSource(sql, sql`t.bot_id`, sql`t.conversation_id`)}))
      AND (t.routine_id IS NULL OR EXISTS (SELECT 1 FROM bot_routines r WHERE r.id=t.routine_id AND r.enabled AND r.deleted_at IS NULL))`;
}
