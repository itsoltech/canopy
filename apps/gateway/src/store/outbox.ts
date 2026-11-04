import { create, fromBinary, toBinary, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fx } from "./errors.ts";
import type { OutboxRow } from "./rows.ts";

export interface OutboxStore {
  enqueueCommand(input: {
    workerId: string;
    threadId?: string;
    turnId?: string;
    command: MessageInitShape<typeof CommandSchema>;
    ttlSeconds: number;
  }): Fx<Command>;
  pendingCommands(workerId: string): Fx<Command[]>;
  commandDone(commandId: string, ok: boolean, result: JsonValue): Fx<void>;
}

export function outboxStore(sql: SqlClient.SqlClient): OutboxStore {
  return {
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
      }),

    pendingCommands: (workerId) =>
      sql<OutboxRow>`
              SELECT id, worker_id, thread_id, turn_id, kind, payload FROM worker_commands
               WHERE worker_id = ${workerId}::uuid AND status IN ('pending', 'delivered') AND expires_at > now() ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map((r) => fromBinary(CommandSchema, r.payload))),
      ),

    commandDone: (commandId, ok, result) =>
      sql`
              UPDATE worker_commands SET status = ${ok ? "completed" : "failed"}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
               WHERE id = ${commandId}::uuid`.pipe(Effect.asVoid),
  };
}
