import { create } from "@bufbuild/protobuf";
import { CommandSchema, TurnOutcome } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { outboxStore } from "../store/outbox.ts";
import type { BotCore } from "./store-queue.ts";
import type { BotTurn } from "./types.ts";
import { uuid } from "./store-views.ts";

/** Fence output, retain the visible partial reply and persist cancellation before acknowledging Stop. */
export function interruptBot(sql: SqlClient.SqlClient, core: BotCore, user: string, botId: string) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* core.owned(user, botId, true);

      const turn = (yield* sql<BotTurn>`SELECT * FROM bot_turns
        WHERE bot_id = ${botId}::uuid AND handoff_configuration IS NULL
          AND status IN ('running','waiting','queued') AND (routine_id IS NULL OR status = 'waiting')
        ORDER BY CASE WHEN status IN ('running','waiting') THEN 0 ELSE 1 END, created_at, id LIMIT 1 FOR UPDATE`)[0];

      if (!turn) return undefined;

      const harness = (yield* sql<{ worker_id: string; text: string }>`SELECT worker_id, text
        FROM bot_harness_turns WHERE turn_id = ${turn.id}::uuid FOR UPDATE`)[0];

      if (harness) {
        yield* outboxStore(sql).enqueueCommand({
          workerId: harness.worker_id,
          ttlSeconds: 365 * 86400,
          command: create(CommandSchema, {
            kind: { case: "interruptBotTurn", value: { threadId: botId, turnId: turn.id } },
          }),
        });
        yield* sql`UPDATE bot_harness_turns SET outcome = ${TurnOutcome.INTERRUPTED},
          finished_at = now(), reason = 'Stopped by you' WHERE turn_id = ${turn.id}::uuid`;
      }

      if (!turn.routine_id) {
        if (harness?.text)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
            VALUES (${uuid()}::uuid, ${botId}::uuid, ${turn.id}::uuid, 'answer', ${botId}, 'user', 'message', ${harness.text})
            ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
          VALUES (${uuid()}::uuid, ${botId}::uuid, ${turn.id}::uuid, 'stopped', 'self', 'user', 'event', 'Stopped by you')
          ON CONFLICT(turn_id, message_key) DO NOTHING`;
      }

      yield* sql`UPDATE bot_turns SET status = 'interrupted', lease_token = NULL, lease_until = NULL,
        finished_at = now() WHERE id = ${turn.id}::uuid`;
      yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now()
        WHERE turn_id = ${turn.id}::uuid AND status = 'pending'`;
      yield* sql`UPDATE bots SET status_line = '', revision = revision + 1 WHERE id = ${botId}::uuid`;

      return { turnId: turn.id, workerId: harness?.worker_id };
    }),
  );
}
