import { fromBinary, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { CommandSchema, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { storageJson } from "./event-text.ts";

/** Replace a rejected command atomically, retaining the turn, note bindings, ordinal and original expiry. */
export const retryTurnStart = (sql: SqlClient.SqlClient, commandId: string, result: JsonValue) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const thread = (yield* sql<{ id: string; closed: boolean }>`
        SELECT t.id, (t.archived_at IS NOT NULL OR t.deleted_at IS NOT NULL) AS closed
        FROM threads t JOIN worker_commands c ON c.thread_id = t.id
        WHERE c.id = ${commandId}::uuid FOR UPDATE OF t`)[0];

      if (!thread) return undefined;

      const rejected = (yield* sql<{ worker_id: string; turn_id: string; payload: Uint8Array; expires_at: Date }>`
        UPDATE worker_commands SET status = 'failed', result = ${JSON.stringify(storageJson(result))}::jsonb,
          completed_at = now()
        WHERE id = ${commandId}::uuid AND kind = 'startTurn' AND status IN ('pending', 'delivered')
        RETURNING worker_id, turn_id, payload, expires_at`)[0];

      if (!rejected || thread.closed) return undefined;
      const queued = yield* sql`SELECT id FROM turns WHERE id = ${rejected.turn_id}::uuid AND status = 'queued'`;

      if (!queued[0]) return undefined;

      const command: Command = fromBinary(CommandSchema, rejected.payload);
      command.commandId = Bun.randomUUIDv7();
      yield* sql`
        INSERT INTO worker_commands (id, worker_id, thread_id, turn_id, kind, payload, expires_at)
        VALUES (${command.commandId}::uuid, ${rejected.worker_id}::uuid, ${thread.id}::uuid,
          ${rejected.turn_id}::uuid, 'startTurn', ${toBinary(CommandSchema, command)}, ${rejected.expires_at})`;

      return command;
    }),
  );
