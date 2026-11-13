import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { AttachmentStore } from "../store/attachments.ts";
import { BotStore, botConfiguration } from "../bots/store.ts";
import { storedBotImage } from "../bots/attachments.ts";
import { botFileResponse } from "../bots/tools/workspace.ts";
import type { ToolContext } from "../bots/tools/shared.ts";
import { coreState } from "./core-context.ts";

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

/** Existing upload validation plus one fenced transaction for storage, message, audit and tool result. */
export async function sendBotAttachment(ctx: ToolContext) {
  const file = await receiveFile(ctx);

  return ctx.action(async () => {
    const actions = ctx.core[coreState].actions;
    const bot = await actions.run(BotStore.use((s) => s.owned(ctx.options.userId, ctx.turn.bot_id, true)));

    if (botConfiguration(bot).files === false)
      throw new Invalid("Files are disabled for this bot. Enable Files in bot settings.");
    const attachment = await ctx.core.uploadAttachment(file.name, file.data);
    const row = await actions.run(AttachmentStore.use((s) => s.owned(ctx.options.userId, attachment.id)));
    const caption = ctx.optional("caption").slice(0, 4000);

    await actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE attachments SET bot_id=${ctx.turn.bot_id}::uuid, bot_turn_id=${ctx.turn.id}::uuid
        WHERE id=${attachment.id}::uuid AND owner_user_id=${ctx.options.userId}::uuid AND bot_id IS NULL AND thread_id IS NULL`;
        yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text,attachments)
        VALUES (${Bun.randomUUIDv7()}::uuid,${ctx.turn.bot_id}::uuid,${ctx.turn.id}::uuid,${`attachment:${ctx.call.id}`},${ctx.turn.bot_id},'user','message',${caption},${JSON.stringify([storedBotImage(row)])}::jsonb)
        ON CONFLICT(turn_id,message_key) DO NOTHING`;
        yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${ctx.call.id}::uuid,${ctx.options.userId}::uuid,'bot.send_attachment','bot',${ctx.turn.bot_id}::uuid,
        ${JSON.stringify({ attachment_id: attachment.id, name: row.name, size_bytes: Number(row.size_bytes), mime_type: row.mime_type })}::jsonb)
        ON CONFLICT(id) DO NOTHING`;
        yield* BotStore.use((s) => s.changed(ctx.turn.bot_id));
      }),
    );

    return {
      attachment_id: attachment.id,
      name: row.name,
      size_bytes: Number(row.size_bytes),
      mime_type: row.mime_type,
      delivered: true,
    };
  });
}
