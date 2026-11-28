import { createHash } from "node:crypto";
import type { AttachmentLimits } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { AttachmentStore, type AttachmentRow } from "../store/attachments.ts";
import { messengerAdapter } from "../messengers/adapters.ts";
import { MessengerStore } from "../messengers/store.ts";
import { messengerLabel } from "../messengers/provider.ts";
import { BotStore, botConfiguration } from "../bots/store.ts";
import { storedBotImage } from "../bots/attachments.ts";
import { botFileResponse } from "../bots/tools/workspace.ts";
import type { ToolContext } from "../bots/tools/shared.ts";
import { coreState } from "./core-context.ts";
import { copySharedBotFile } from "./bot-share-file.ts";

async function receiveFile(ctx: ToolContext) {
  const limit = Math.min(50 * 1024 ** 2, (await ctx.core.attachmentLimits).maxFileBytes);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let size = -1;
  let sha256 = "";
  let name = "";

  try {
    do {
      const result = await botFileResponse(ctx, "export", BigInt(offset));

      if (size < 0) {
        size = Number(result.sizeBytes);
        sha256 = result.sha256;
        name = result.name;
      }

      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > limit ||
        result.sizeBytes !== BigInt(size) ||
        result.sha256 !== sha256 ||
        result.name !== name ||
        (result.data.length === 0 && offset < size) ||
        offset + result.data.length > size
      )
        throw new Invalid(
          "The file exceeds the attachment limit or changed during transfer. Choose a smaller file, then retry.",
        );
      chunks.push(result.data);
      offset += result.data.length;
    } while (offset < size);
  } finally {
    await botFileResponse(ctx, "release").catch(() => undefined);
  }

  const data = Buffer.concat(chunks);

  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw new Invalid("The file transfer was incomplete. Try again.");

  return { name, data };
}

/** In an external conversation the file joins this turn's reply instead of the owner's private chat. */
async function queueReplyFile(ctx: ToolContext, row: AttachmentRow, limits: AttachmentLimits) {
  const actions = ctx.core[coreState].actions;

  // The upload is still uncommitted inside this action, so the queue entry must join the same transaction.
  const queued = await actions.run(
    MessengerStore.use((s) =>
      s.queueReplyFile(
        ctx.options.userId,
        ctx.turn,
        row.id,
        (provider) => messengerAdapter(provider).maxFileBytes,
        limits,
      ),
    ),
  );

  await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${ctx.call.id}::uuid,${ctx.options.userId}::uuid,'bot.send_attachment','bot',${ctx.turn.bot_id}::uuid,
        ${JSON.stringify({ attachment_id: row.id, name: row.name, size_bytes: Number(row.size_bytes), mime_type: row.mime_type, conversation_id: ctx.turn.conversation_id })}::jsonb)
        ON CONFLICT(id) DO NOTHING`;
    }),
  );

  return {
    attachment_id: row.id,
    name: row.name,
    size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type,
    delivered: false,
    queued_for_reply: queued.queued,
    note: `Queued for your final reply in ${messengerLabel(queued.provider)}. Skipping the reply also skips this file.`,
  };
}

/** Existing upload validation plus one fenced transaction for storage, message, audit and tool result. */
export async function sendBotAttachment(ctx: ToolContext) {
  const id = ctx.optional("attachment_id");
  const path = ctx.optional("path");

  if (Boolean(path) === Boolean(id))
    throw new Invalid("Provide either a workspace filename or an attachment ID from this conversation.");

  const file = path ? await receiveFile(ctx) : undefined;

  return ctx.action(async () => {
    const actions = ctx.core[coreState].actions;
    const bot = await actions.run(BotStore.use((s) => s.owned(ctx.options.userId, ctx.turn.bot_id, true)));

    if (botConfiguration(bot).files === false)
      throw new Invalid("Files are disabled for this bot. Enable Files in bot settings.");
    const limits = await ctx.core.attachmentLimits;
    const row = file ? await storeUploadedBotFile(ctx, file) : await copySharedBotFile(ctx, id, limits);

    await actions.run(
      SqlClient.SqlClient.use(
        (sql) => sql`UPDATE attachments SET bot_id=${ctx.turn.bot_id}::uuid, bot_turn_id=${ctx.turn.id}::uuid
          WHERE id=${row.id}::uuid AND owner_user_id=${ctx.options.userId}::uuid AND bot_id IS NULL AND thread_id IS NULL`,
      ),
    );

    if (ctx.turn.conversation_id) return queueReplyFile(ctx, row, limits);
    const caption = ctx.optional("caption").slice(0, 4000);

    await actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text,attachments)
        VALUES (${Bun.randomUUIDv7()}::uuid,${ctx.turn.bot_id}::uuid,${ctx.turn.id}::uuid,${`attachment:${ctx.call.id}`},${ctx.turn.bot_id},'user','message',${caption},${JSON.stringify([storedBotImage(row)])}::jsonb)
        ON CONFLICT(turn_id,message_key) DO NOTHING`;
        yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${ctx.call.id}::uuid,${ctx.options.userId}::uuid,'bot.send_attachment','bot',${ctx.turn.bot_id}::uuid,
        ${JSON.stringify({ attachment_id: row.id, name: row.name, size_bytes: Number(row.size_bytes), mime_type: row.mime_type })}::jsonb)
        ON CONFLICT(id) DO NOTHING`;
        yield* BotStore.use((s) => s.changed(ctx.turn.bot_id));
      }),
    );

    return {
      attachment_id: row.id,
      name: row.name,
      size_bytes: Number(row.size_bytes),
      mime_type: row.mime_type,
      delivered: true,
    };
  });
}

async function storeUploadedBotFile(ctx: ToolContext, file: Awaited<ReturnType<typeof receiveFile>>) {
  const attachment = await ctx.core.uploadAttachment(file.name, file.data);

  return ctx.core[coreState].actions.run(AttachmentStore.use((s) => s.owned(ctx.options.userId, attachment.id)));
}
