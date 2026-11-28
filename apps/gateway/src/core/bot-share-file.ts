import type { AttachmentLimits } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { botMemoryAccess } from "../bots/memory.ts";
import type { ToolContext } from "../bots/tools/shared.ts";
import type { AttachmentRow } from "../store/attachments.ts";
import { isUuid } from "../store/agent-bus-queries.ts";
import { Invalid } from "../store/errors.ts";
import { coreState } from "./core-context.ts";

/** Copy only refs present in this bot's conversation. Isolated callbacks can share their own input. */
export function copySharedBotFile(ctx: ToolContext, id: string, limits: AttachmentLimits) {
  if (!isUuid(id)) throw new Invalid("Choose a Canopy attachment ID from this conversation.");
  const { userId } = ctx.options;
  const { turn } = ctx;

  return ctx.core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const access = yield* botMemoryAccess(sql, userId, turn);
      const canReadHistory = access.ownerInput || Boolean(access.conversationId);

      const [file] = yield* sql<AttachmentRow>`SELECT a.* FROM attachments a JOIN bot_turns t ON t.id=a.bot_turn_id
        JOIN bot_turns current_turn ON current_turn.id=${turn.id}::uuid AND current_turn.bot_id=t.bot_id
        WHERE a.id=${id}::uuid AND a.owner_user_id=${userId}::uuid
          AND a.bot_id=t.bot_id AND a.thread_id IS NULL
          AND t.conversation_id IS NOT DISTINCT FROM current_turn.conversation_id
          AND t.slack_context_epoch IS NOT DISTINCT FROM current_turn.slack_context_epoch
          AND t.routine_id IS NOT DISTINCT FROM current_turn.routine_id
          AND (t.id=current_turn.id OR (${canReadHistory}
            AND t.exchange_id IS NULL AND t.reply_to_bot_id IS NULL AND t.remote_recipient_ref IS NULL
            AND (t.created_at,t.id)<(current_turn.created_at,current_turn.id)))
          AND EXISTS (SELECT 1 FROM bot_messages m WHERE m.turn_id=t.id AND m.bot_id=t.bot_id
            AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text)))
        FOR SHARE OF a`;

      if (!file) return yield* Effect.fail(new Invalid("This file is unavailable in the current conversation."));

      if (Number(file.size_bytes) > Math.min(limits.maxFileBytes, limits.maxMessageBytes))
        return yield* Effect.fail(new Invalid("This file exceeds the attachment size limit. Choose a smaller file."));

      const [copy] = yield* sql<AttachmentRow>`INSERT INTO attachments
        (id,owner_user_id,sha256,thumb_sha256,name,mime_type,kind,size_bytes,width,height,duration_ms)
        SELECT ${Bun.randomUUIDv7()}::uuid,owner_user_id,sha256,thumb_sha256,name,mime_type,kind,size_bytes,width,height,duration_ms
        FROM attachments WHERE id=${file.id}::uuid RETURNING *`;

      return copy!;
    }),
  );
}
