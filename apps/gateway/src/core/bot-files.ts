import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { splitId } from "@canopy/domain/computers";
import { formatSize, type JsonObject } from "@canopy/domain";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { BotStore } from "../bots/store.ts";
import { Invalid } from "../store/store.ts";
import type { AttachmentRow } from "../store/attachments.ts";
import type { BotTurn, StoredCall } from "../bots/types.ts";

export function forwardingIds(args: JsonObject): readonly string[] {
  return Schema.decodeUnknownSync(Schema.Array(Schema.String.check(Schema.isUUID())))(args["attachment_ids"] ?? []);
}

/** Both listing and forwarding resolve sent files in this owner's bot conversation only. */
export async function conversationFiles(core: GatewayCore, turn: BotTurn, ids?: readonly string[]) {
  const owner = core[coreState].options.userId;
  await core.bots.get(turn.bot_id);

  return core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<AttachmentRow>`SELECT a.* FROM attachments a JOIN bots b ON b.id=a.bot_id
      WHERE a.owner_user_id=${owner}::uuid AND b.owner_user_id=${owner}::uuid
        AND b.id=${turn.bot_id}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
        AND a.bot_turn_id IS NOT NULL ORDER BY a.id`;

      if (ids === undefined) return rows;
      const byId = new Map(rows.map((r) => [r.id, r]));

      if (new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)))
        return yield* Effect.fail(
          new Invalid("A file is unavailable in this conversation. Use list_attachments to choose files."),
        );
      const selected = ids.map((id) => byId.get(id)!);
      const limits = yield* Effect.promise(() => core.attachmentLimits);

      if (
        ids.length > limits.maxFiles ||
        selected.some((r) => Number(r.size_bytes) > limits.maxFileBytes) ||
        selected.reduce((total, r) => total + Number(r.size_bytes), 0) > limits.maxMessageBytes
      )
        return yield* Effect.fail(
          new Invalid("These files exceed the attachment limits. Send fewer or smaller files."),
        );

      return selected;
    }),
  );
}

export function localForwardTarget(args: JsonObject, ids: readonly string[]) {
  if (
    ids.length &&
    [args["thread_id"], args["project_id"], args["workspace_id"]].some(
      (id) => Schema.is(Schema.String)(id) && splitId(id).node,
    )
  )
    throw new Invalid("Files cannot be forwarded to another computer. Choose a thread on this bot's computer.");
}

/** Called inside botAction: new references share the original immutable blobs and roll back with the action. */
export async function copyConversationFiles(core: GatewayCore, turn: BotTurn, call: StoredCall) {
  const ids = forwardingIds(call.arguments);
  localForwardTarget(call.arguments, ids);

  if (!ids.length) return [];
  const rows = await conversationFiles(core, turn, ids);

  return core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const copies: string[] = [];

      for (const row of rows) {
        const id = Bun.randomUUIDv7();
        yield* sql`INSERT INTO attachments(id, owner_user_id, sha256, thumb_sha256, name, mime_type, kind, size_bytes, width, height)
        SELECT ${id}::uuid, owner_user_id, sha256, thumb_sha256, name, mime_type, kind, size_bytes, width, height
        FROM attachments WHERE id=${row.id}::uuid AND bot_id=${turn.bot_id}::uuid AND owner_user_id=${core[coreState].options.userId}::uuid`;
        copies.push(id);
      }

      return copies;
    }),
  );
}

export async function forwardedNotice(core: GatewayCore, turn: BotTurn, call: StoredCall, title: string) {
  const ids = forwardingIds(call.arguments);

  if (!ids.length) return;
  const files = await conversationFiles(core, turn, ids);
  const text = `Sent ${files.map((f) => f.name).join(", ")} to “${title || "Thread"}”`;

  await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${`files:${call.id}`}, ${turn.bot_id}, 'user', 'event', ${text})
      ON CONFLICT(turn_id, message_key) DO NOTHING`;
      yield* BotStore.use((s) => s.changed(turn.bot_id));
    }),
  );
}

export async function forwardingApproval(core: GatewayCore, turn: BotTurn, call: StoredCall, prompt: string) {
  const ids = forwardingIds(call.arguments);
  localForwardTarget(call.arguments, ids);

  if (!ids.length) return undefined;
  const files = await conversationFiles(core, turn, ids);

  return {
    prompt: `${prompt}\nFiles:\n${files.map((f) => `- ${f.name} (${f.mime_type}, ${formatSize(Number(f.size_bytes))})`).join("\n")}`,
  };
}
