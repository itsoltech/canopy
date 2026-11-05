import { fromBinary, toBinary, type JsonValue } from "@bufbuild/protobuf";
import {
  CommandSchema,
  ItemDeltaField,
  ThreadEventSchema,
  TurnOutcome,
  type Command,
  type ThreadEvent,
} from "@canopy/contracts";
import { Effect } from "effect";
import { classifyFailure } from "@canopy/domain";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import type { BotAccess } from "./store-access.ts";
import type { BotTurn } from "./types.ts";
import type { AgentToolCall } from "@canopy/contracts";

export interface HarnessTurnRow {
  turn_id: string;
  bot_id: string;
  worker_id: string;
  command_id: string;
  text: string;
  outcome: number | null;
  source: number;
  reason: string;
  error_code: string;
  error_class: string;
  items: Record<string, string>;
}

/** Bot events use the worker journal, with independent storage and owner/worker checks. */
export function botHarnessStore(sql: SqlClient.SqlClient, access: BotAccess) {
  return {
    abandonHarnessCall: (user: string, workerId: string, call: AgentToolCall) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* access.owned(user, call.botId, true);

          const turn = yield* sql`SELECT t.id FROM bot_turns t JOIN bot_harness_turns h ON h.turn_id = t.id
            WHERE t.id = ${call.turnId}::uuid AND t.bot_id = ${call.botId}::uuid
              AND h.worker_id = ${workerId}::uuid FOR UPDATE OF t`;

          if (!turn.length) return;
          // A tombstone also fences cancellation that overtakes the first execution.
          yield* sql`INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments, status, result)
            VALUES (${Bun.randomUUIDv7()}::uuid, ${call.turnId}::uuid, ${call.callId}, '{}'::jsonb, '{}'::jsonb,
              'interrupted', '{"error":"This request expired. Do not retry it."}'::jsonb)
            ON CONFLICT (turn_id, call_key) DO UPDATE SET status = 'interrupted',
              result = '{"error":"This request expired. Do not retry it."}'::jsonb
            WHERE bot_tool_calls.status = 'pending'`;
          yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now()
            WHERE id IN (SELECT id FROM bot_tool_calls WHERE turn_id = ${call.turnId}::uuid AND call_key = ${call.callId})
              AND status = 'pending'`;
          yield* access.changed(call.botId);
        }),
      ),
    harnessTurn: (id: string) =>
      sql<HarnessTurnRow>`SELECT * FROM bot_harness_turns WHERE turn_id = ${id}::uuid`.pipe(Effect.map((r) => r[0])),
    harnessCommand: (turn: BotTurn, workerId: string, command: Command) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* access.fenced(turn);

          const existing = (yield* sql<{
            payload: Uint8Array;
          }>`SELECT c.payload FROM bot_harness_turns h JOIN worker_commands c ON c.id = h.command_id WHERE h.turn_id = ${turn.id}::uuid`)[0];

          if (existing) return fromBinary(CommandSchema, existing.payload);
          yield* sql`INSERT INTO worker_commands(id, worker_id, kind, payload, expires_at) VALUES (${command.commandId}::uuid, ${workerId}::uuid, 'runBotTurn', ${toBinary(CommandSchema, command)}, now() + interval '365 days')`;
          yield* sql`INSERT INTO bot_harness_turns(turn_id, bot_id, worker_id, command_id) VALUES (${turn.id}::uuid, ${turn.bot_id}::uuid, ${workerId}::uuid, ${command.commandId}::uuid)`;

          return command;
        }),
      ),
    harnessCommandFailure: (id: string) =>
      sql<{
        result: JsonValue;
      }>`SELECT c.result FROM bot_harness_turns h JOIN worker_commands c ON c.id = h.command_id WHERE h.turn_id = ${id}::uuid AND c.status = 'failed'`.pipe(
        Effect.map((r) => r[0]?.result),
      ),
    harnessDispatchable: (id: string) =>
      sql`SELECT h.turn_id FROM bot_harness_turns h JOIN bot_turns t ON t.id = h.turn_id JOIN bots b ON b.id = h.bot_id
        WHERE h.command_id = ${id}::uuid AND t.status IN ('queued','running','waiting') AND h.outcome IS NULL
        AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    assignWorker: (user: string, botId: string, workerId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* access.owned(user, botId, true);

          const workers =
            yield* sql`SELECT id FROM workers WHERE id = ${workerId}::uuid AND (owner_user_id = ${user}::uuid OR owner_user_id IS NULL) AND revoked_at IS NULL AND archived_at IS NULL`;

          if (!workers.length) return yield* Effect.fail(new Invalid("worker not found"));
          yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{workerId}', to_jsonb(${workerId}::text)), revision = revision + 1 WHERE id = ${botId}::uuid AND coalesce(configuration ->> 'workerId', '') = ''`;
        }),
      ),
    harnessCursors: (workerId: string, journalId: string) =>
      sql<{
        bot_id: string;
        last_seq: bigint;
      }>`SELECT h.bot_id, max(e.journal_seq) AS last_seq FROM bot_harness_events e JOIN bot_harness_turns h ON h.turn_id = e.turn_id WHERE e.worker_id = ${workerId}::uuid AND e.journal_id = ${journalId} GROUP BY h.bot_id`.pipe(
        Effect.map((rows) => rows.map((r) => ({ threadId: r.bot_id, lastSeq: BigInt(r.last_seq) }))),
      ),
    harnessEvent: (workerId: string, journalId: string, event: ThreadEvent) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Recovered transcripts and older workers may still carry provider prose.
          if (event.body.case === "turnFinished" && event.body.value.outcome === TurnOutcome.FAILED) {
            const end = event.body.value;
            event = {
              ...event,
              rawJson: "",
              body: {
                case: "turnFinished",
                value: {
                  ...end,
                  errorClass: classifyFailure(end.reason, end.errorClass || end.errorCode),
                  reason: "Bot harness could not finish this turn",
                },
              },
            };
          }

          yield* sql`SELECT b.id FROM bots b JOIN bot_harness_turns h ON h.bot_id = b.id
            WHERE h.turn_id = ${event.turnId}::uuid AND h.bot_id = ${event.threadId}::uuid
              AND h.worker_id = ${workerId}::uuid FOR UPDATE OF b`;
          yield* sql`SELECT id FROM bot_turns WHERE id = ${event.turnId}::uuid FOR UPDATE`;

          const row =
            (yield* sql<HarnessTurnRow>`SELECT h.* FROM bot_harness_turns h WHERE h.turn_id = ${event.turnId}::uuid AND h.bot_id = ${event.threadId}::uuid AND h.worker_id = ${workerId}::uuid FOR UPDATE`)[0];

          if (!row) return false;

          const saved =
            yield* sql`INSERT INTO bot_harness_events(event_id, turn_id, worker_id, journal_id, journal_seq, payload) VALUES (${event.eventId}::uuid, ${row.turn_id}::uuid, ${workerId}::uuid, ${journalId}, ${event.journalSeq}, ${toBinary(ThreadEventSchema, event)}) ON CONFLICT DO NOTHING RETURNING event_id`;

          if (!saved.length) return true;

          // A terminal journal record is immutable, including when later reconnect replay arrives.
          if (row.outcome !== null) return true;
          const body = event.body;

          if (body.case === "itemCompleted" && body.value.item?.content.case === "agentMessage") {
            const item = body.value.item;
            row.items[item.itemId] = item.content.case === "agentMessage" ? item.content.value.text : "";
          }

          if (body.case === "itemDelta" && body.value.field === ItemDeltaField.TEXT)
            row.items[body.value.itemId] = (row.items[body.value.itemId] ?? "") + body.value.chunk;
          const text = Object.values(row.items).join("\n");
          const end = body.case === "turnFinished" ? body.value : undefined;

          if (end)
            yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now()
              WHERE turn_id = ${row.turn_id}::uuid AND status = 'pending'`;
          yield* sql`UPDATE bot_harness_turns SET items = ${JSON.stringify(row.items)}::jsonb, text = ${text}, outcome = ${end?.outcome ?? row.outcome}, source = ${end?.source ?? row.source}, reason = ${end?.reason ?? row.reason}, error_code = ${end?.errorCode ?? row.error_code}, error_class = ${end?.errorClass ?? row.error_class} WHERE turn_id = ${row.turn_id}::uuid`;
          yield* access.changed(row.bot_id);

          return true;
        }),
      ),
    harnessAuthorized: (user: string, workerId: string, botId: string, turnId: string) =>
      sql`SELECT h.turn_id FROM bot_harness_turns h JOIN bots b ON b.id = h.bot_id JOIN bot_turns t ON t.id = h.turn_id
        WHERE h.turn_id = ${turnId}::uuid AND h.bot_id = ${botId}::uuid AND h.worker_id = ${workerId}::uuid AND b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL AND t.status = 'running' AND h.outcome IS NULL`.pipe(
        Effect.map((r) => r.length > 0),
      ),
  };
}
