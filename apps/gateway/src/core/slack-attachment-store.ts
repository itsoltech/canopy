import { create } from "@bufbuild/protobuf";
import { InputAttachmentSchema } from "@canopy/contracts";
import { attachmentPath } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { PreparedAttachment } from "../attachments/prepare.ts";
import { BotStore, botConfiguration } from "../bots/store.ts";
import type { BotTurn } from "../bots/types.ts";
import { ConnectorFailure, type ExecutionSource } from "../connectors/records.ts";
import { inboundSlackTurnFiles } from "../messengers/store-inbound-files.ts";
import { AttachmentStore, type AttachmentRow } from "../store/attachments.ts";
import type { CoreRuntime, CoreServices } from "./core-context.ts";

export function slackInputAttachment(row: AttachmentRow, path = "") {
  return create(InputAttachmentSchema, {
    attachmentId: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sha256: row.sha256,
    kind: row.kind,
    sizeBytes: BigInt(row.size_bytes),
    path,
  });
}

export function lockSlackBotConversation(sql: SqlClient.SqlClient, turn: BotTurn) {
  return turn.conversation_id
    ? sql`SELECT a.id FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
        JOIN messenger_accounts a ON a.id=r.account_id WHERE c.id=${turn.conversation_id}::uuid FOR SHARE OF r,a`.pipe(
        Effect.asVoid,
      )
    : Effect.void;
}

/** Imports immutable blobs through the usual attachment store, fencing the durable conversation before binding. */
export function bindBotSlackAttachment<E>(
  runtime: CoreRuntime,
  userId: string,
  turn: BotTurn,
  fileId: string,
  prepared: PreparedAttachment,
  authorize?: Effect.Effect<void, E, CoreServices>,
): Promise<AttachmentRow> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* BotStore.use((s) => s.fenced(turn));
          const bot = yield* BotStore.use((s) => s.owned(userId, turn.bot_id));

          if (botConfiguration(bot).files === false)
            return yield* Effect.fail(new ConnectorFailure("Files are disabled for this bot."));

          if (authorize) yield* authorize;
          else {
            yield* lockSlackBotConversation(sql, turn);

            if (!(yield* inboundSlackTurnFiles(sql, userId, turn, fileId)).length)
              return yield* Effect.fail(
                new ConnectorFailure("The Slack file is no longer available in this conversation."),
              );
          }

          const existing = (yield* sql<AttachmentRow>`SELECT * FROM attachments
            WHERE owner_user_id=${userId}::uuid AND bot_id=${turn.bot_id}::uuid
            AND bot_turn_id=${turn.id}::uuid AND slack_file_id=${fileId}`)[0];

          if (existing) return existing;
          const row = yield* AttachmentStore.use((s) => s.create({ ...prepared, ownerUserId: userId }));

          yield* sql`UPDATE attachments SET bot_id=${turn.bot_id}::uuid,bot_turn_id=${turn.id}::uuid,slack_file_id=${fileId}
            WHERE id=${row.id}::uuid`;

          return { ...row, bot_id: turn.bot_id, bot_turn_id: turn.id };
        }),
      );
    }),
  );
}

export function bindThreadSlackAttachment<E>(
  runtime: CoreRuntime,
  source: ExecutionSource,
  prepared: PreparedAttachment,
  authorize: Effect.Effect<void, E, CoreServices>,
) {
  const { threadId, turnId, workerId, userId } = source;

  if (!threadId || !turnId || !workerId) throw new ConnectorFailure("This Slack download requires an active thread.");

  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const running = yield* sql`SELECT th.id FROM threads th JOIN turns tr ON tr.thread_id=th.id
            WHERE th.id=${threadId}::uuid AND tr.id=${turnId}::uuid AND th.worker_id=${workerId}::uuid
            AND th.owner_user_id=${userId}::uuid AND th.deleted_at IS NULL AND th.archived_at IS NULL
            AND th.rewind_pending_id IS NULL AND tr.rewind_id IS NULL AND tr.status='running' FOR UPDATE OF th,tr`;

          if (!running.length)
            return yield* Effect.fail(new ConnectorFailure("This Slack download requires an active thread."));
          yield* authorize;

          const { root, os } = yield* AttachmentStore.use((s) => s.workerRoot(workerId));

          if (!root) return yield* Effect.fail(new ConnectorFailure("Update this worker to download Slack files."));
          const row = yield* AttachmentStore.use((s) => s.create({ ...prepared, ownerUserId: userId }));

          yield* sql`UPDATE attachments SET thread_id=${threadId}::uuid,turn_id=${turnId}::uuid WHERE id=${row.id}::uuid`;

          return slackInputAttachment(row, attachmentPath(root, os, threadId, row.id, row.name));
        }),
      );
    }),
  );
}
