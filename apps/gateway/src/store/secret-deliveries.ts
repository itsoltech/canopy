import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret } from "./secrets.ts";
import type { ThreadSecretRow } from "./thread-secrets.ts";

/** Advance the durable reconnect sweep. Revision/status/value and receipts remain authoritative. */
const resetBatch = (sql: SqlClient.SqlClient, worker: string, reset: boolean) =>
  Effect.gen(function* () {
    if (reset)
      yield* sql`INSERT INTO worker_secret_replays(worker_id) VALUES(${worker}::uuid)
    ON CONFLICT(worker_id) DO UPDATE SET last_id=NULL`;

    const jobs = yield* sql<{ last_id: string | null }>`SELECT last_id FROM worker_secret_replays
    WHERE worker_id=${worker}::uuid FOR UPDATE`;

    if (!jobs.length) return;
    const after = jobs[0]!.last_id;

    const rows = yield* sql<{
      id: string;
    }>`UPDATE thread_secrets SET applied_revision=0 WHERE id IN (
    SELECT s.id FROM thread_secrets s JOIN threads t ON t.id=s.thread_id
    WHERE t.worker_id=${worker}::uuid AND s.revision>0 AND (${after}::uuid IS NULL OR s.id>${after}::uuid)
    ORDER BY s.id LIMIT 256 FOR UPDATE OF s) RETURNING id`;

    if (rows.length) {
      const last = rows
        .map((row) => row.id)
        .toSorted()
        .at(-1)!;

      yield* sql`UPDATE worker_secret_replays SET last_id=${last}::uuid WHERE worker_id=${worker}::uuid`;
    } else {
      yield* sql`DELETE FROM worker_secret_replays WHERE worker_id=${worker}::uuid`;
    }
  });

type DeliveryRow = (ThreadSecretRow & { replay_pending: false }) | { replay_pending: true };

const claim = (sql: SqlClient.SqlClient, worker: string, checkReplay: boolean) =>
  sql<DeliveryRow>`WITH replay AS MATERIALIZED (
      SELECT worker_id FROM worker_secret_replays WHERE ${checkReplay} AND worker_id=${worker}::uuid FOR UPDATE
    ), previous AS MATERIALIZED (
      SELECT last_id FROM worker_secret_delivery_cursors WHERE worker_id=${worker}::uuid
        AND NOT EXISTS(SELECT 1 FROM replay) FOR UPDATE
    ), due AS MATERIALIZED (
      SELECT s.id,t.cwd AS worker_cwd,coalesce(s.id<=p.last_id,false) AS wrapped
      FROM thread_secrets s JOIN threads t ON t.id=s.thread_id LEFT JOIN previous p ON true
      WHERE t.worker_id=${worker}::uuid AND s.revision>s.applied_revision AND NOT EXISTS(SELECT 1 FROM replay)
      ORDER BY coalesce(s.id<=p.last_id,false),s.id LIMIT 64 FOR UPDATE OF s SKIP LOCKED
    ), advanced AS (
      INSERT INTO worker_secret_delivery_cursors(worker_id,last_id)
      SELECT ${worker}::uuid,id FROM due ORDER BY wrapped DESC,id DESC LIMIT 1
      ON CONFLICT(worker_id) DO UPDATE SET last_id=excluded.last_id RETURNING worker_id
    ) SELECT s.*,due.worker_cwd,false AS replay_pending FROM due
      JOIN thread_secrets s ON s.id=due.id CROSS JOIN advanced
    UNION ALL SELECT s.*,''::text,true FROM replay LEFT JOIN thread_secrets s ON false`;

export function secretDeliveries(sql: SqlClient.SqlClient, key: Buffer, worker: string, reset: boolean) {
  // Claim and cursor commit in one statement. Only a replay sweep needs several statements in a transaction.
  const replay = (restart: boolean) =>
    sql.withTransaction(Effect.andThen(resetBatch(sql, worker, restart), claim(sql, worker, false)));

  const take = reset
    ? replay(true)
    : claim(sql, worker, true).pipe(
        Effect.flatMap((rows) => (rows.some((row) => row.replay_pending) ? replay(false) : Effect.succeed(rows))),
      );

  return take.pipe(
    Effect.map((rows) =>
      rows.flatMap((r) =>
        r.replay_pending
          ? []
          : [
              {
                $typeName: "canopy.worker.v1.ThreadSecretDelivery" as const,
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
              },
            ],
      ),
    ),
  );
}
