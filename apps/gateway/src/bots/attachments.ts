import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from "@canopy/domain";
import { Invalid } from "../store/store.ts";
import { type AttachmentRow, type StoredAttachment } from "../store/attachments.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared upload storage, revalidated under the sending transaction before binding to a bot turn. */
export function botImages(sql: SqlClient.SqlClient, user: string, ids: readonly string[], limits?: AttachmentLimits) {
  return Effect.gen(function* () {
    if (!ids.length) return [];

    if (!ids.every((id) => UUID.test(id)) || new Set(ids).size !== ids.length)
      return yield* Effect.fail(new Invalid("Choose each uploaded file once."));

    const settings = (yield* sql<{
      max_file: string | null;
      max_message: string | null;
      max_files: number | null;
    }>`SELECT settings #>> '{attachmentLimits,maxFileBytes}' AS max_file,
        settings #>> '{attachmentLimits,maxMessageBytes}' AS max_message,
        (settings #>> '{attachmentLimits,maxFiles}')::integer AS max_files
      FROM user_settings WHERE user_id=${user}::uuid`)[0];

    const max = settings?.max_file
      ? {
          maxFileBytes: Number(settings.max_file),
          maxMessageBytes: Number(settings.max_message),
          maxFiles: Number(settings.max_files),
        }
      : (limits ?? DEFAULT_ATTACHMENT_LIMITS);

    if (ids.length > max.maxFiles) return yield* Effect.fail(new Invalid(`Attach up to ${max.maxFiles} files.`));

    const rows = yield* sql<AttachmentRow>`SELECT * FROM attachments
      WHERE owner_user_id=${user}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;

    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: AttachmentRow[] = [];

    for (const id of ids) {
      const row = byId.get(id);

      if (!row || row.thread_id || row.bot_id)
        return yield* Effect.fail(new Invalid("This file is unavailable. Upload it again."));

      if (Number(row.size_bytes) > max.maxFileBytes)
        return yield* Effect.fail(new Invalid("This file exceeds the size limit. Choose a smaller file."));
      ordered.push(row);
    }

    if (ordered.reduce((sum, r) => sum + Number(r.size_bytes), 0) > max.maxMessageBytes)
      return yield* Effect.fail(new Invalid("These files exceed the message size limit. Remove a file."));

    return ordered;
  });
}

export const storedBotImage = (row: AttachmentRow): StoredAttachment => ({
  id: row.id,
  name: row.name,
  mimeType: row.mime_type,
  kind: row.kind,
  sizeBytes: Number(row.size_bytes),
  ...(row.width && { width: row.width }),
  ...(row.height && { height: row.height }),
  sha256: row.sha256,
  hasThumbnail: row.thumb_sha256 !== null,
  path: "",
});
