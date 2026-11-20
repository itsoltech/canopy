import type { SqlClient } from "effect/sql";

/** A preview is available only within its verified, live thread tree and owner. */
export function threadBlobAccess(sql: SqlClient.SqlClient, threadId: string, sha256: string, owner?: string) {
  return sql`EXISTS (
    SELECT 1 FROM thread_blobs p JOIN threads t ON t.id=p.thread_id
    JOIN threads requested ON requested.root_thread_id=t.root_thread_id AND requested.owner_user_id=t.owner_user_id
    WHERE p.verified AND p.sha256=${sha256} AND t.deleted_at IS NULL
      AND requested.id=${threadId}::uuid AND requested.deleted_at IS NULL
      ${owner !== undefined ? sql`AND requested.owner_user_id=${owner}::uuid` : sql``})`;
}
