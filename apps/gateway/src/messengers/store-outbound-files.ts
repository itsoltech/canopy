import { Effect } from "effect";
import type { AttachmentLimits } from "@canopy/domain";
import type { SqlClient } from "effect/sql";
import type { BotTurn } from "../bots/types.ts";
import { Invalid } from "../store/store.ts";
import { activeChannelTurn } from "./conversation-access.ts";
import { MAX_REPLY_BYTES, MAX_REPLY_FILES, messengerLabel, type MessengerProvider } from "./provider.ts";

export interface OutboundFileRow {
  name: string;
  mime_type: string;
  sha256: string;
}

/** Files queued for a turn's reply. The reply's outbox row reads them when it is sent. */
export function messengerOutboundFiles(sql: SqlClient.SqlClient) {
  return {
    /** Queues a stored attachment for the reply of the active external turn it came from. */
    queueReplyFile: (
      owner: string,
      turn: BotTurn,
      attachmentId: string,
      maxFileBytes: (p: MessengerProvider) => number,
      limits: AttachmentLimits,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!turn.conversation_id) return yield* Effect.fail(new Invalid("Files go to a conversation reply."));

          const [route] = yield* sql<{ delivery: string; provider: MessengerProvider }>`SELECT r.delivery,a.provider
            FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
            JOIN messenger_accounts a ON a.id=r.account_id
            WHERE c.id=${turn.conversation_id}::uuid AND r.bot_id=${turn.bot_id}::uuid AND r.owner_user_id=${owner}::uuid`;

          if (!route || !(yield* activeChannelTurn(sql, turn.id)))
            return yield* Effect.fail(new Invalid("This conversation no longer accepts replies."));

          if (route.delivery !== "reply")
            return yield* Effect.fail(
              new Invalid(
                "This subscription notifies the owner in Canopy, so files cannot be sent to the conversation.",
              ),
            );

          // One queue per turn: concurrent tool calls must not pick the same position or exceed the limits.
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.outbound_files:' || ${turn.id}, 0))`;

          const [file] = yield* sql<{ size: string }>`SELECT size_bytes::text AS size FROM attachments
            WHERE id=${attachmentId}::uuid AND owner_user_id=${owner}::uuid AND bot_turn_id=${turn.id}::uuid`;

          if (!file) return yield* Effect.fail(new Invalid("The file is unavailable. Send it again."));
          const label = messengerLabel(route.provider);
          const limit = maxFileBytes(route.provider);

          if (Number(file.size) > limit)
            return yield* Effect.fail(
              new Invalid(
                `${label} accepts files up to ${Math.floor(limit / 1024 ** 2)} MB from bots. Send a smaller file.`,
              ),
            );

          const [queued] = yield* sql<{ count: number; bytes: string; last: number }>`SELECT count(*)::int AS count,
            coalesce(sum(a.size_bytes),0)::text AS bytes,coalesce(max(f.ordinal),0)::int AS last
            FROM messenger_outbound_files f JOIN attachments a ON a.id=f.attachment_id WHERE f.turn_id=${turn.id}::uuid`;

          const count = Math.min(limits.maxFiles, MAX_REPLY_FILES);
          const bytes = Math.min(limits.maxMessageBytes, MAX_REPLY_BYTES);

          if (queued!.count >= count || Number(queued!.bytes) + Number(file.size) > bytes)
            return yield* Effect.fail(
              new Invalid("These attachments exceed the reply limits. Send fewer or smaller files."),
            );

          yield* sql`INSERT INTO messenger_outbound_files(turn_id,attachment_id,ordinal)
            VALUES(${turn.id}::uuid,${attachmentId}::uuid,${queued!.last + 1}) ON CONFLICT DO NOTHING`;

          return { provider: route.provider, queued: queued!.count + 1 };
        }),
      ),
    /** Files of an outbox row, in the order the bot queued them. */
    outboundFiles: (owner: string, outboundId: string) =>
      sql<OutboundFileRow>`SELECT a.name,a.mime_type,a.sha256 FROM messenger_outbound o
        JOIN messenger_outbound_files f ON f.turn_id=o.turn_id
        JOIN attachments a ON a.id=f.attachment_id AND a.owner_user_id=${owner}::uuid
        WHERE o.id=${outboundId}::uuid ORDER BY f.ordinal`,
  };
}

/** Whether a finished turn queued files, so a reply without text is still sent. */
export function queuedReplyFiles(sql: SqlClient.SqlClient, turnId: string) {
  return sql<{ queued: boolean }>`SELECT EXISTS(SELECT 1 FROM messenger_outbound_files
    WHERE turn_id=${turnId}::uuid) AS queued`.pipe(Effect.map(([row]) => row?.queued === true));
}
