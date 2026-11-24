import { maxNotificationBadge } from "@canopy/domain/notification-badge";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ownerModule } from "../store/module-access.ts";

export const readMobilePushBadge = (owner: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Match the overview's latest unseen turn and visible interactions without loading thread previews.
    const [row] = yield* sql<{ badge: number }>`
      WITH badge_threads AS (
        SELECT 1 FROM threads t
        JOIN projects p ON p.id = t.project_id AND p.owner_user_id = t.owner_user_id AND p.archived_at IS NULL
        LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = t.owner_user_id
        WHERE t.owner_user_id = ${owner}::uuid AND ${ownerModule(sql, owner, "threads")}
          AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.moved_to IS NULL
          AND t.origin <> 'agent' AND t.remote_parent_ref IS NULL
          AND NOT EXISTS (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id
            AND parent.owner_user_id = t.owner_user_id AND parent.archived_at IS NOT NULL)
          AND (
            EXISTS (SELECT 1 FROM interaction_requests i
              WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'human'
                AND (i.expires_at IS NULL OR i.expires_at > now())
                AND (i.question_wait IS DISTINCT FROM false OR t.status NOT IN ('running', 'creating')))
            OR (SELECT u.status <> 'interrupted' OR u.interrupt_source IS DISTINCT FROM 'user'
                FROM turns u WHERE u.thread_id = t.id AND u.status IN ('completed', 'failed', 'interrupted')
                  AND u.last_seq > coalesce(r.seen_seq, 0)
                ORDER BY u.last_seq DESC LIMIT 1)
          )
          AND NOT mobile_push_thread_muted(t.id, t.owner_user_id)
        LIMIT ${maxNotificationBadge}
      ), active_bots AS (
        SELECT b.id, b.last_read_seq FROM bots b
        WHERE b.owner_user_id = ${owner}::uuid AND ${ownerModule(sql, owner, "bots")}
          AND b.archived_at IS NULL AND b.deleted_at IS NULL AND b.moved_to IS NULL
      ), badge_messages AS (
        SELECT 1 FROM active_bots b JOIN bot_messages m ON m.bot_id = b.id AND m.seq > b.last_read_seq
        WHERE m.sender_id = b.id::text AND m.recipient_id = 'user' AND m.kind = 'message'
        LIMIT ${maxNotificationBadge}
      ), badge_bot_cards AS (
        -- Projected thread approvals are already represented by their original requests.
        SELECT DISTINCT a.bot_id FROM active_bots b JOIN bot_approvals a ON a.bot_id = b.id
        WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > now())
        LIMIT ${maxNotificationBadge}
      )
      SELECT least(${maxNotificationBadge}::int, (SELECT count(*) FROM badge_threads) +
        (SELECT count(*) FROM badge_messages) + (SELECT count(*) FROM badge_bot_cards))::int AS badge`;

    return row?.badge;
  }).pipe(Effect.timeout("1 second"));
