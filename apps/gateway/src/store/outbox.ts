import { create, fromBinary, toBinary, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fx } from "./errors.ts";
import type { OutboxRow } from "./rows.ts";
import { storageJson } from "./event-text.ts";
import { queryFamily } from "../diagnostics/query-context.ts";
import { retryTurnStart } from "./retry-turn-start.ts";

export interface PendingCommand {
  readonly command: Command;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface OutboxStore {
  enqueueCommand(input: {
    workerId: string;
    threadId?: string;
    turnId?: string;
    command: MessageInitShape<typeof CommandSchema>;
    ttlSeconds: number;
  }): Fx<Command>;
  /** Ordered keyset page, at most 2048 commands / about 512 KiB. Rewind and unload intents never expire before ACK. */
  pendingCommands(workerId: string, afterId?: string): Fx<PendingCommand[]>;
  commandDispatchable(commandId: string): Fx<boolean>;
  commandDone(commandId: string, ok: boolean, result: JsonValue): Fx<void>;
  retryTurnStart(commandId: string, result: JsonValue): Fx<Command | undefined>;
  /** Recheck lifecycle after a retry delay or reconnect, before handing a start to the worker. */
  turnStartDispatchable(commandId: string): Fx<boolean>;
}

export function outboxStore(sql: SqlClient.SqlClient): OutboxStore {
  return {
    commandDispatchable: (commandId) =>
      sql`SELECT id FROM worker_commands
      WHERE id = ${commandId}::uuid AND status IN ('pending', 'delivered')
        AND (expires_at > now() OR kind IN ('rewindThread', 'unloadThread'))`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    retryTurnStart: (commandId, result) => retryTurnStart(sql, commandId, result),
    turnStartDispatchable: (commandId) =>
      sql`
      SELECT c.id FROM worker_commands c JOIN turns u ON u.id = c.turn_id JOIN threads t ON t.id = c.thread_id
      WHERE c.id = ${commandId}::uuid AND c.status IN ('pending', 'delivered') AND c.expires_at > now()
        AND u.status IN ('queued', 'running') AND u.rewind_id IS NULL AND t.rewind_pending_id IS NULL
        AND t.archived_at IS NULL AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM worker_commands cleanup WHERE cleanup.thread_id = t.id
          AND cleanup.kind = 'unloadThread' AND cleanup.status IN ('pending', 'delivered'))`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    enqueueCommand: ({ workerId, threadId, turnId, command, ttlSeconds }) =>
      Effect.gen(function* () {
        const message = create(CommandSchema, { ...command });
        message.commandId ||= Bun.randomUUIDv7();

        yield* sql`
                INSERT INTO worker_commands (id, worker_id, thread_id, turn_id, kind, payload, expires_at)
                VALUES (${message.commandId}::uuid, ${workerId}::uuid, ${threadId ?? null}::uuid, ${turnId ?? null}::uuid,
                        ${message.kind.case ?? "unknown"}, ${toBinary(CommandSchema, message)}, now() + make_interval(secs => ${ttlSeconds}))
                ON CONFLICT (id) DO NOTHING`;

        return message;
      }).pipe(queryFamily("commands.write")),

    pendingCommands: (workerId, afterId) =>
      sql<Pick<OutboxRow, "id" | "payload"> & { expires_at: Date; created_at: Date }>`
        WITH candidates AS MATERIALIZED (
          SELECT id, payload, created_at, expires_at FROM worker_commands
          WHERE worker_id = ${workerId}::uuid AND status IN ('pending', 'delivered')
            AND (expires_at > now() OR kind IN ('rewindThread', 'unloadThread'))
          ${afterId ? sql`AND (created_at, id) > (SELECT created_at, id FROM worker_commands WHERE id = ${afterId}::uuid AND worker_id = ${workerId}::uuid)` : sql``}
          ORDER BY created_at, id LIMIT 2048
        ), budget AS (
          SELECT b.*, coalesce(sum(octet_length(b.payload)) OVER
            (ORDER BY b.created_at,b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding_bytes
          FROM candidates b
        )
        SELECT b.id,b.payload,b.expires_at,b.created_at FROM budget b
        WHERE b.preceding_bytes < 524288 ORDER BY b.created_at,b.id`.pipe(
        queryFamily("commands.pending"),
        Effect.map((rows) =>
          rows.map((row) => {
            const command = fromBinary(CommandSchema, row.payload);
            command.commandId = row.id;

            return { command, expiresAt: row.expires_at, createdAt: row.created_at };
          }),
        ),
      ),

    commandDone: (commandId, ok, result) =>
      sql`
              UPDATE worker_commands SET status = ${ok ? "completed" : "failed"}, result = ${JSON.stringify(storageJson(result))}::jsonb, completed_at = now()
               WHERE id = ${commandId}::uuid`.pipe(queryFamily("commands.write"), Effect.asVoid),
  };
}
