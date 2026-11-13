import { toJson } from "@bufbuild/protobuf";
import { MentionKind, ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { toUiTurn } from "./ui-mappers.ts";
import type { TurnRow } from "./rows.ts";
import { Invalid } from "./errors.ts";

/** Sent attachments are immutable. A draft gets new owner-scoped bindings to the same content blobs. */
export const rewindDraft = (sql: SqlClient.SqlClient, owner: string, target: TurnRow) =>
  Effect.gen(function* () {
    const draft = toUiTurn(target);

    for (const attachment of draft.attachments) {
      const id = Bun.randomUUIDv7();

      const rows =
        yield* sql`INSERT INTO attachments(id,owner_user_id,sha256,thumb_sha256,name,mime_type,kind,size_bytes,width,height,duration_ms)
        SELECT ${id}::uuid,owner_user_id,sha256,thumb_sha256,name,mime_type,kind,size_bytes,width,height,duration_ms
        FROM attachments WHERE id=${attachment.id}::uuid AND owner_user_id=${owner}::uuid RETURNING id`;

      if (!rows.length)
        return yield* Effect.fail(new Invalid("A file is unavailable. Restore it before editing this message."));

      for (const mention of draft.mentions)
        if (mention.kind === MentionKind.ATTACHMENT && mention.name === attachment.id) mention.name = id;
      attachment.id = id;
    }

    return toJson(ui.TurnSchema, draft);
  });
