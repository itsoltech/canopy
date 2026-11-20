import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots, type computerLink as link } from "@canopy/contracts";
import { Effect } from "effect";
import { MOVED_FILE_COLUMNS, movedFilesSize, readMovedFile, type MovedFileRow } from "./move-files.ts";
import { insertRows, MAX_FILES, MoveRefused, type Sql } from "./move-payload.ts";
import { insertMovedFileBytes, movedAttachment } from "./move-validation.ts";
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
      WHERE a.owner_user_id=$2::uuid AND b.data IS NOT NULL AND (
        (a.bot_id=$1::uuid AND EXISTS(SELECT 1 FROM bot_turns u WHERE u.id=a.bot_turn_id AND u.bot_id=a.bot_id AND u.conversation_id IS NULL))
        OR (a.bot_id IS NULL AND a.thread_id IS NULL AND a.id=ANY($3::uuid[])))`,
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
      const row = movedAttachment(file);
      yield* insertMovedFileBytes(sql, file, row);
      yield* insertRows(
        sql,
        "attachments",
        [
          {
            ...row,
            owner_user_id: owner,
            bot_id: row["bot_id"] ? botId : null,
            thread_id: null,
            turn_id: null,
            slack_file_id: null,
            thumb_sha256: file.thumbnail.length ? row.thumb_sha256 : null,
          },
        ],
        { strict: true },
      );
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
