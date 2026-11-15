import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots, type computerLink as link } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import { MOVED_FILE_COLUMNS, movedFilesSize, readMovedFile, type MovedFileRow } from "./move-files.ts";
import { insertRows, JsonRow, MAX_FILES, MoveRefused, type Sql } from "./move-payload.ts";
import type { ComputerStore } from "./store.ts";

/** Includes unsent images referenced by the durable draft, as well as conversation images. */
export async function exportBotComposer(store: ComputerStore, botId: string) {
  const row = (
    await store.query<{ payload: Uint8Array; revision: bigint }>(
      `SELECT payload, revision FROM bot_composer_drafts WHERE bot_id=$1::uuid AND owner_user_id=$2::uuid`,
      [botId, store.owner],
    )
  )[0];

  const draft = row
    ? create(bots.BotComposerDraftSchema, {
        ...fromBinary(bots.BotComposerDraftSchema, row.payload),
        botId,
        revision: BigInt(row.revision),
      })
    : undefined;

  const files = await store.query<MovedFileRow>(
    `SELECT ${MOVED_FILE_COLUMNS}
      FROM attachments a JOIN blobs b ON b.sha256=a.sha256 LEFT JOIN blobs t ON t.sha256=a.thumb_sha256
      WHERE a.owner_user_id=$2::uuid AND (a.bot_id=$1::uuid OR a.id=ANY($3::uuid[])) AND b.data IS NOT NULL`,
    [botId, store.owner, draft?.attachments.map((a) => a.id) ?? []],
  );

  if (movedFilesSize(files) > MAX_FILES) throw new MoveRefused("The bot's images are too large to move (over 40 MiB).");
  const moved: link.MovedFile[] = [];

  for (const file of files) moved.push(await readMovedFile(store, file));

  return { draft, files: moved };
}

/** Runs inside the move transaction, after turns exist and before the bot becomes visible. */
export function importBotComposer(sql: Sql, owner: string, botId: string, moved: link.BotMove) {
  return Effect.gen(function* () {
    for (const file of moved.files) {
      const row = Schema.decodeUnknownSync(JsonRow)(JSON.parse(file.attachmentJson));

      if (row["bot_id"] !== null && row["bot_id"] !== botId) throw new Error("Invalid bot image move");
      yield* sql.unsafe(
        `INSERT INTO blobs(sha256,size_bytes,mime_type,data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [row["sha256"], file.data.length, file.mimeType, file.data],
      );

      if (row["thumb_sha256"] && file.thumbnail.length)
        yield* sql.unsafe(
          `INSERT INTO blobs(sha256,size_bytes,mime_type,data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [row["thumb_sha256"], file.thumbnail.length, file.thumbnailMimeType, file.thumbnail],
        );
      yield* insertRows(sql, "attachments", [{ ...row, owner_user_id: owner }]);
    }

    if (moved.draft) {
      const draft = create(bots.BotComposerDraftSchema, { ...moved.draft, botId });
      yield* sql.unsafe(
        `INSERT INTO bot_composer_drafts(bot_id,owner_user_id,payload,revision) VALUES ($1::uuid,$2::uuid,$3,$4)`,
        [botId, owner, toBinary(bots.BotComposerDraftSchema, draft), draft.revision],
      );
    }
  });
}
