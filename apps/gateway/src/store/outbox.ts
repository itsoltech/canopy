import { create, fromBinary, toBinary, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { Fx } from "./errors.ts";
import type { OutboxRow } from "./rows.ts";
import { storageJson } from "./event-text.ts";
import { queryFamily } from "../diagnostics/query-context.ts";
import { lockModuleAdmission, ownerModule } from "./module-access.ts";
import { activeChannelTurn, lockChannelAccount } from "../messengers/conversation-access.ts";
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
  }): Effect.Effect<Command, SqlError.SqlError>;
  /** Ordered keyset page, at most 2048 commands / about 512 KiB. Rewind and unload intents never expire before ACK. */
  pendingCommands(workerId: string, afterId?: string, cleanupOnly?: boolean): Fx<PendingCommand[]>;
  commandDispatchable(commandId: string): Fx<boolean>;
  /** Hand off to the link under a shared row lock. Wait for the ACK outside the transaction. */
  sendPending<A>(command: Command, send: () => A): Fx<A | undefined>;
  commandDone(commandId: string, ok: boolean, result: JsonValue, legacyThrough?: string): Fx<boolean>;
  retryTurnStart(commandId: string, result: JsonValue): Fx<Command | undefined>;
  /** Recheck lifecycle after a retry delay or reconnect, before handing a start to the worker. */
  turnStartDispatchable(commandId: string): Fx<boolean>;
}

function admitBotCommand(sql: SqlClient.SqlClient, commandId: string, turnId: string) {
  return Effect.gen(function* () {
    const [turn] = yield* sql<{ conversation_id: string | null }>`SELECT conversation_id FROM bot_turns
      WHERE id=${turnId}::uuid`;

    if (!turn?.conversation_id) return true;
    yield* lockChannelAccount(sql, turn.conversation_id);

    if (yield* activeChannelTurn(sql, turnId)) return true;
    yield* sql`UPDATE worker_commands SET status='failed',result='{"errorCode":"TURN_NOT_RUNNING"}'::jsonb
      WHERE id=${commandId}::uuid AND status IN ('pending','delivered')`;

    return false;
  });
}

/** A bot command once attempted is never refused later: the worker may have received it. */
const botAttempt = (sql: SqlClient.SqlClient, commandId: string) =>
  sql`UPDATE worker_commands c SET status = 'delivered', delivered_epoch = w.epoch
    FROM worker_connections w WHERE c.id = ${commandId}::uuid AND c.status = 'pending'
      AND w.worker_id = c.worker_id`.pipe(Effect.asVoid);

export function outboxStore(sql: SqlClient.SqlClient): OutboxStore {
  return {
    commandDispatchable: (commandId) =>
      sql`SELECT id FROM worker_commands
      WHERE id = ${commandId}::uuid AND status IN ('pending', 'delivered')
        AND (expires_at > now() OR kind IN ('rewindThread', 'unloadThread'))`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    sendPending: (command, send) =>
      Effect.andThen(
        // Commit the attempt before a frame can leave the gateway, including across a crash at send time.
        // The sandbox trigger needs the thread lock. Take it before the command, as archive and delete do.
        command.kind.case === "startTurn" || command.kind.case === "steerTurn"
          ? sql`WITH attempt AS MATERIALIZED (
              SELECT c.id, w.epoch FROM worker_commands c
              JOIN threads t ON t.id = c.thread_id
              JOIN worker_connections w ON w.worker_id = c.worker_id
              WHERE c.id = ${command.commandId}::uuid AND c.status = 'pending'
              FOR SHARE OF t
            )
            UPDATE worker_commands c SET status = 'delivered', delivered_epoch = attempt.epoch FROM attempt
            WHERE c.id = attempt.id AND c.status = 'pending'`.pipe(Effect.asVoid)
          : command.kind.case === "runBotTurn"
            ? botAttempt(sql, command.commandId)
            : Effect.void,
        sql.withTransaction(
          Effect.gen(function* () {
            const bot = command.kind.case === "runBotTurn";

            const entity = bot
              ? sql`JOIN bot_harness_turns h ON h.command_id = c.id AND h.outcome IS NULL JOIN bots entity ON entity.id = h.bot_id`
              : sql`JOIN threads entity ON entity.id = c.thread_id`;

            const ready = bot
              ? sql``
              : sql`AND NOT EXISTS (SELECT 1 FROM worker_commands cleanup
            WHERE cleanup.thread_id = c.thread_id AND cleanup.kind = 'unloadThread'
              AND cleanup.status IN ('pending','delivered'))`;

            // Lock the actual entity owner even when the worker serves several owners. Read the flag afterwards
            // so a rewind waiting behind a disable sees its commit even though its durable intent is retained.
            yield* lockModuleAdmission(
              sql,
              sql`(SELECT entity.owner_user_id FROM worker_commands c ${entity}
            WHERE c.id = ${command.commandId}::uuid)`,
            );

            if (
              command.kind.case === "runBotTurn" &&
              !(yield* admitBotCommand(sql, command.commandId, command.kind.value.turnId))
            )
              return undefined;

            const pending = yield* sql`SELECT c.id FROM worker_commands c ${entity}
            WHERE c.id = ${command.commandId}::uuid AND c.status IN ('pending','delivered')
              AND (c.kind NOT IN ('startTurn','steerTurn') OR c.status = 'delivered')
              AND (c.expires_at > now() OR c.kind = 'rewindThread')
              AND ${ownerModule(sql, sql`entity.owner_user_id`, bot ? "bots" : "threads")} ${ready}
            FOR UPDATE OF c`;

            if (!pending.length) return;

            return send();
          }),
        ),
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
        const kind = message.kind;

        const sandboxDigest =
          kind.case === "createThread" || kind.case === "startTurn"
            ? kind.value.profiledThread?.binding?.digest
            : undefined;

        yield* sql`
                INSERT INTO worker_commands (id, worker_id, thread_id, turn_id, kind, payload, expires_at, delivered_epoch, sandbox_digest)
                VALUES (${message.commandId}::uuid, ${workerId}::uuid, ${threadId ?? null}::uuid, ${turnId ?? null}::uuid,
                        ${kind.case ?? "unknown"}, ${toBinary(CommandSchema, message)}, now() + make_interval(secs => ${ttlSeconds}), 0, ${sandboxDigest ?? null})
                ON CONFLICT (id) DO NOTHING`;

        return message;
      }).pipe(queryFamily("commands.write")),

    pendingCommands: (workerId, afterId, cleanupOnly) =>
      sql<Pick<OutboxRow, "id" | "payload"> & { expires_at: Date; created_at: Date }>`
        WITH candidates AS MATERIALIZED (
          SELECT id, payload, created_at, expires_at FROM worker_commands
          WHERE worker_id = ${workerId}::uuid AND status IN ('pending', 'delivered')
            AND (expires_at > now() OR kind IN ('rewindThread', 'unloadThread'))
          ${cleanupOnly ? sql`AND kind IN ('interruptTurn', 'unloadThread', 'interruptBotTurn')` : sql``}
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

    commandDone: (commandId, ok, result, legacyThrough) =>
      sql`
              UPDATE worker_commands SET status = ${ok ? "completed" : "failed"}, result = ${JSON.stringify(storageJson(result))}::jsonb, completed_at = now()
               WHERE id = ${commandId}::uuid AND status IN ('pending','delivered')
                ${legacyThrough === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM threads t WHERE t.id=worker_commands.thread_id AND t.last_seq=${legacyThrough}::bigint)`}
               RETURNING id`.pipe(
        queryFamily("commands.write"),
        Effect.map((rows) => rows.length > 0),
      ),
  };
}
