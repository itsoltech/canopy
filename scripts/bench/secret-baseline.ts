import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import type { ThreadSecretRow } from "../../apps/gateway/src/store/thread-secrets.ts";

/** Frozen pre-batching behavior, for alternating paired samples on the same synthetic database. */
export function baselineSecrets(sql: SqlClient.SqlClient, key: Buffer, worker: string, name: string) {
  if (name === "secrets/expire")
    return Effect.map(
      sql<ThreadSecretRow>`UPDATE thread_secrets s
    SET status='expired',ciphertext=NULL,key_id=NULL,file_path=NULL,revision=revision+1 FROM threads t
    WHERE t.id=s.thread_id AND ((s.status='saved' AND s.expires_at<=now()) OR
      (s.status IN ('saved','pending') AND (t.deleted_at IS NOT NULL OR t.archived_at IS NOT NULL)))
    RETURNING s.*`,
      (rows) => rows.length,
    );

  return sql.withTransaction(
    Effect.gen(function* () {
      if (name === "secrets/reset")
        yield* sql`UPDATE thread_secrets s SET applied_revision=0
      FROM threads t WHERE t.id=s.thread_id AND t.worker_id=${worker}::uuid AND s.revision>0`;

      const rows = yield* sql<ThreadSecretRow>`SELECT s.*,t.cwd AS worker_cwd FROM thread_secrets s
      JOIN threads t ON t.id=s.thread_id WHERE t.worker_id=${worker}::uuid
        AND s.revision>s.applied_revision ORDER BY s.created_at`;

      const deliveries = rows.map((r) => ({
        $typeName: "canopy.worker.v1.ThreadSecretDelivery",
        requestId: r.id,
        threadId: r.thread_id,
        revision: r.revision,
        cwd: r.worker_cwd ?? "",
        value:
          r.status === "saved" && r.ciphertext && r.expires_at && new Date(r.expires_at).getTime() > Date.now()
            ? decryptSecret(key, r.ciphertext)
            : "",
        ...(r.expires_at && { expiresAt: timestampFromDate(new Date(r.expires_at)) }),
        remove: r.status !== "saved" || !r.expires_at || new Date(r.expires_at).getTime() <= Date.now(),
      }));

      return deliveries.length;
    }),
  );
}
