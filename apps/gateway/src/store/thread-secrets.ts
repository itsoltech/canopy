import { create, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui, type ThreadSecretDelivery, type ThreadSecretReceipt } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { CallSource } from "./agent-bus.ts";
import { Invalid, NotFound } from "./store.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";

type Fx<A> = Effect.Effect<A, SqlError.SqlError | Invalid | NotFound>;
export interface ThreadSecretRow {
  worker_cwd?: string;
  id: string; thread_id: string; turn_id: string; call_id: string;
  label: string; description: string; placeholder: string; name: string;
  status: string; ciphertext: Uint8Array | null; expires_at: Date | null;
  revision: number; applied_revision: number; file_path: string | null;
}
export interface ThreadSecretsStore {
  requestSecret(source: CallSource, args: AgentBusArgs["request_secret"]): Fx<ThreadSecretRow>;
  threadSecrets(ownerId: string, threadId: string): Fx<ui.ThreadSecret[]>;
  secretResult(threadId: string, requestId: string): Fx<JsonValue>;
  answerSecret(ownerId: string, requestId: string, value: string, decline: boolean, ttlMs: number): Fx<ThreadSecretRow>;
  revokeSecret(ownerId: string, requestId: string): Fx<ThreadSecretRow>;
  expireSecrets(): Fx<readonly ThreadSecretRow[]>;
  secretDeliveries(workerId: string, reset?: boolean): Fx<ThreadSecretDelivery[]>;
  secretReceipt(workerId: string, receipt: ThreadSecretReceipt): Fx<void>;
}

export function toUiThreadSecret(row: ThreadSecretRow): ui.ThreadSecret {
  return create(ui.ThreadSecretSchema, {
    requestId: row.id, threadId: row.thread_id, label: row.label, description: row.description,
    placeholder: row.placeholder, name: row.name, status: row.status,
    ...(row.expires_at && { expiresAt: timestampFromDate(new Date(row.expires_at)) }),
  });
}

/** Values never enter normal interactions, agent-bus arguments/results or worker_commands. */
export function threadSecretsStore(sql: SqlClient.SqlClient, key: Buffer): ThreadSecretsStore {
  const owned = (ownerId: string, id: string) => Effect.gen(function* () {
    const rows = yield* sql<ThreadSecretRow>`SELECT s.* FROM thread_secrets s JOIN threads t ON t.id = s.thread_id
      WHERE s.id = ${id}::uuid AND t.owner_user_id = ${ownerId}::uuid AND t.deleted_at IS NULL FOR UPDATE OF s`;
    if (!rows[0]) return yield* Effect.fail(new NotFound("secret request not found"));
    return rows[0];
  });
  return {
    requestSecret: (source, args) => sql.withTransaction(Effect.gen(function* () {
      const threads = yield* sql`SELECT id FROM threads WHERE id = ${source.threadId}::uuid
        AND worker_id IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
      if (!threads[0]) return yield* Effect.fail(new NotFound("active worker thread not found"));
      if (args.request_id) {
        const rows = yield* sql<ThreadSecretRow>`SELECT * FROM thread_secrets WHERE id = ${args.request_id}::uuid AND thread_id = ${source.threadId}::uuid`;
        if (!rows[0]) return yield* Effect.fail(new NotFound("secret request not found in this thread"));
        return rows[0];
      }
      const existing = yield* sql<ThreadSecretRow>`SELECT * FROM thread_secrets WHERE thread_id = ${source.threadId}::uuid
        AND (call_id = ${source.callId}::uuid OR (status = 'pending' AND label = ${args.label})) ORDER BY created_at LIMIT 1`;
      if (existing[0]) return existing[0];
      const turns = yield* sql`SELECT id FROM turns WHERE id = ${source.turnId || null}::uuid AND thread_id = ${source.threadId}::uuid AND status = 'running'`;
      if (!turns[0]) return yield* Effect.fail(new Invalid("request_secret requires a running turn"));
      const rows = yield* sql<ThreadSecretRow>`INSERT INTO thread_secrets(id, thread_id, turn_id, call_id, label, description, placeholder, name)
        VALUES (${source.callId}::uuid, ${source.threadId}::uuid, ${source.turnId}::uuid, ${source.callId}::uuid,
          ${args.label}, ${args.description}, ${args.placeholder ?? ""}, ${args.name ?? ""}) RETURNING *`;
      return rows[0]!;
    })),
    threadSecrets: (ownerId, threadId) => Effect.gen(function* () {
      const rows = yield* sql<ThreadSecretRow>`SELECT s.* FROM thread_secrets s JOIN threads t ON t.id = s.thread_id
        WHERE t.id = ${threadId}::uuid AND t.owner_user_id = ${ownerId}::uuid AND t.deleted_at IS NULL ORDER BY s.created_at`;
      return rows.map(toUiThreadSecret);
    }),
    secretResult: (threadId, id) => Effect.gen(function* () {
      const rows = yield* sql<ThreadSecretRow>`SELECT * FROM thread_secrets WHERE id = ${id}::uuid AND thread_id = ${threadId}::uuid`;
      const row = rows[0];
      if (!row) return yield* Effect.fail(new NotFound("secret request not found in this thread"));
      const base = { request_id: row.id, status: row.status };
      if (row.status !== "saved") return base;
      if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return { ...base, status: "expired" };
      if (row.applied_revision !== row.revision || !row.file_path) return { ...base, status: "pending", delivery: "waiting_for_worker" };
      return { ...base, file: row.file_path, expires_at: new Date(row.expires_at).toISOString(),
        ...(row.name && { name: row.name }),
        instructions: "Read this file only inside commands, e.g. TOKEN=\"$(cat '<file>')\" program. Never print, echo, log or read the value into model context. Do not share it with other threads." };
    }),
    answerSecret: (ownerId, id, value, decline, ttlMs) => sql.withTransaction(Effect.gen(function* () {
      // Validate without including the supplied data in errors (including Effect/SQL errors).
      if ((!decline && (!value.length || Buffer.byteLength(value, "utf8") > 32768 || value.includes("\0"))) || (decline && value.length > 0)) {
        return yield* Effect.fail(new Invalid("provide a secret of 1–32768 bytes without NUL, or decline without a value"));
      }
      const row = yield* owned(ownerId, id);
      // Transport retries are safe; a second answer cannot overwrite an accepted secret.
      if (row.status !== "pending") return row;
      const live = yield* sql`SELECT id FROM threads WHERE id = ${row.thread_id}::uuid AND archived_at IS NULL AND deleted_at IS NULL`;
      if (!live[0]) return yield* Effect.fail(new Invalid("this thread is no longer active"));
      const ciphertext = decline ? null : encryptSecret(key, value);
      const rows = yield* sql<ThreadSecretRow>`UPDATE thread_secrets SET status = ${decline ? "declined" : "saved"},
        ciphertext = ${ciphertext}, key_id = ${decline ? null : SECRETS_KEY_ID},
        expires_at = ${decline ? null : new Date(Date.now() + ttlMs)}, revision = ${decline ? 0 : 1}
        WHERE id = ${id}::uuid RETURNING *`;
      return rows[0]!;
    })),
    revokeSecret: (ownerId, id) => sql.withTransaction(Effect.gen(function* () {
      const row = yield* owned(ownerId, id);
      if (row.status !== "saved" && row.status !== "pending") return row;
      const rows = yield* sql<ThreadSecretRow>`UPDATE thread_secrets SET status = 'revoked', ciphertext = NULL,
        key_id = NULL, file_path = NULL, revision = revision + 1 WHERE id = ${id}::uuid RETURNING *`;
      return rows[0]!;
    })),
    expireSecrets: () => sql<ThreadSecretRow>`UPDATE thread_secrets s SET status = 'expired', ciphertext = NULL,
      key_id = NULL, file_path = NULL, revision = revision + 1 FROM threads t WHERE t.id = s.thread_id AND
      ((s.status = 'saved' AND s.expires_at <= now()) OR (s.status IN ('saved', 'pending') AND (t.deleted_at IS NOT NULL OR t.archived_at IS NOT NULL))) RETURNING s.*`,
    secretDeliveries: (workerId, reset = false) => sql.withTransaction(Effect.gen(function* () {
      if (reset) yield* sql`UPDATE thread_secrets s SET applied_revision = 0 FROM threads t WHERE t.id = s.thread_id AND t.worker_id = ${workerId}::uuid AND s.revision > 0`;
      const rows = yield* sql<ThreadSecretRow>`SELECT s.*, t.cwd AS worker_cwd FROM thread_secrets s JOIN threads t ON t.id = s.thread_id
        WHERE t.worker_id = ${workerId}::uuid AND s.revision > s.applied_revision ORDER BY s.created_at`;
      return rows.map((r) => ({
        $typeName: "canopy.worker.v1.ThreadSecretDelivery" as const,
        requestId: r.id, threadId: r.thread_id, revision: r.revision,
        cwd: r.worker_cwd ?? "",
        value: r.status === "saved" && r.ciphertext && r.expires_at && new Date(r.expires_at).getTime() > Date.now() ? decryptSecret(key, r.ciphertext) : "",
        ...(r.expires_at && { expiresAt: timestampFromDate(new Date(r.expires_at)) }), remove: r.status !== "saved" || !r.expires_at || new Date(r.expires_at).getTime() <= Date.now(),
      }));
    })),
    secretReceipt: (workerId, receipt) => Effect.gen(function* () {
      if (!receipt.applied || receipt.file.length > 4096) return;
      yield* sql`UPDATE thread_secrets s SET applied_revision = ${receipt.revision}, file_path = ${receipt.file || null}
        FROM threads t WHERE t.id = s.thread_id AND t.worker_id = ${workerId}::uuid
          AND s.thread_id = ${receipt.threadId}::uuid AND s.id = ${receipt.requestId}::uuid AND s.revision = ${receipt.revision}`;
    }),
  };
}
