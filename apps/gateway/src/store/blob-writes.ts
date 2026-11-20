import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "./errors.ts";

export function matchesBlob(sha256: string, data: Uint8Array): boolean {
  return createHash("sha256").update(data).digest("hex") === sha256;
}

export const blobWriter = (sql: SqlClient.SqlClient) => (sha256: string, data: Uint8Array, mimeType: string) => {
  if (!matchesBlob(sha256, data)) return Effect.fail(new Invalid("The file does not match its content digest."));

  return sql`INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES (${sha256}, ${data.length}, ${mimeType}, ${data})
    ON CONFLICT (sha256) DO UPDATE SET data=excluded.data, size_bytes=excluded.size_bytes,
      mime_type=excluded.mime_type, storage_url=NULL
    WHERE blobs.data IS DISTINCT FROM excluded.data OR blobs.size_bytes<>excluded.size_bytes`.pipe(Effect.asVoid);
};
