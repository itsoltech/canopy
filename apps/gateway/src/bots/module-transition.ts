import { TurnOutcome } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { fenceBotWorkerCommands } from "../store/module-worker-commands.ts";
import { stoppedRoutineActivity } from "./routine-activity.ts";
import { nextStoredCronRun } from "../core/cron.ts";

const reason = "Stopped because Bots was turned off";

/** The owner module lock is held throughout the settings transaction. */
export function botModuleTransition(sql: SqlClient.SqlClient, owner: string, enabled: boolean) {
  return Effect.gen(function* () {
    const bots = yield* sql<{ id: string }>`SELECT id FROM bots WHERE owner_user_id=${owner}::uuid
      AND deleted_at IS NULL ORDER BY id FOR UPDATE`;

    const ids = bots.map((b) => b.id);
    // Events and batches recorded around a transition are never delivered after it, including an event whose
    // transaction commits later: it carries the previous generation.
    yield* sql`INSERT INTO bot_trigger_generations(owner_user_id, generation) VALUES (${owner}::uuid, 1)
      ON CONFLICT (owner_user_id) DO UPDATE SET generation = bot_trigger_generations.generation + 1`;
    yield* sql`DELETE FROM bot_trigger_events WHERE owner_user_id=${owner}::uuid`;
    yield* sql`UPDATE bot_trigger_batches SET status='dropped', reason=${enabled ? "Bots was turned on" : reason},
      closed_at=now(), check_after=NULL WHERE status='open'
      AND trigger_id IN (SELECT id FROM bot_routines WHERE bot_id=ANY(${ids}::uuid[]))`;

    if (enabled) {
      const now = new Date();

      const missed = yield* sql<{ id: string; cron: string; timezone: string }>`SELECT id, cron, timezone
        FROM bot_routines WHERE bot_id=ANY(${ids}::uuid[]) AND enabled AND deleted_at IS NULL
        AND next_run_at<=${now} FOR UPDATE`;

      for (const r of missed) {
        const next = nextStoredCronRun(r.cron, r.timezone, now);
        yield* sql`UPDATE bot_routines SET next_run_at=${next ?? null}, enabled=${Boolean(next)}, updated_at=now()
          WHERE id=${r.id}::uuid`;
      }

      return;
    }

    yield* fenceBotWorkerCommands(sql, owner);

    // Unstarted inputs stay in FIFO order. Discard enqueued cron ticks and never replay a
    // partially executed turn, including one just re-queued by an approval answer.
    const stopped = yield* sql<{ id: string }>`UPDATE bot_turns t SET status='interrupted',
      lease_token=NULL, lease_until=NULL, finished_at=now() WHERE bot_id=ANY(${ids}::uuid[]) AND
      (status IN ('running','waiting') OR (status='queued' AND (checkpoint <> '[]'::jsonb
        OR (routine_id IS NOT NULL AND (client_request_id LIKE 'routine:%' OR client_request_id LIKE 'trigger:%'))
        OR client_request_id LIKE 'parked:%'
        OR EXISTS(SELECT 1 FROM bot_harness_turns h WHERE h.turn_id=t.id)))) RETURNING id`;

    const turns = stopped.map((t) => t.id);

    yield* sql`UPDATE bot_harness_turns h SET outcome=${TurnOutcome.INTERRUPTED}, reason=${reason}, finished_at=now()
      FROM bots b WHERE h.bot_id=b.id AND b.owner_user_id=${owner}::uuid AND h.outcome IS NULL`;
    // Parked cards expire with the module, without continuations.
    yield* sql`UPDATE bot_approvals SET status='expired', answered_at=now()
      WHERE bot_id=ANY(${ids}::uuid[]) AND parked AND status='pending'`;

    if (!turns.length) return;
    yield* stoppedRoutineActivity(sql, turns);
    yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
      SELECT gen_random_uuid(),t.bot_id,t.id,'answer',t.bot_id::text,'user','message',h.text
      FROM bot_turns t JOIN bot_harness_turns h ON h.turn_id=t.id WHERE t.id=ANY(${turns}::uuid[])
      AND NOT t.reaction_input AND t.routine_id IS NULL AND t.conversation_id IS NULL AND t.handoff_configuration IS NULL AND h.text<>''
      ON CONFLICT(turn_id,message_key) DO NOTHING`;
    yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
      SELECT gen_random_uuid(),bot_id,id,'stopped','self','user','event',${reason} FROM bot_turns
      WHERE id=ANY(${turns}::uuid[]) AND NOT reaction_input AND routine_id IS NULL AND conversation_id IS NULL
      AND handoff_configuration IS NULL ON CONFLICT(turn_id,message_key) DO NOTHING`;
    yield* sql`UPDATE bot_approvals SET status='expired', answered_at=now()
      WHERE turn_id=ANY(${turns}::uuid[]) AND status='pending'`;
    yield* sql`UPDATE bot_tool_calls SET status='interrupted', result=jsonb_build_object('error',
      CASE WHEN status='running' THEN 'Interrupted during execution. The outcome is unknown. Ask before retrying.' ELSE ${reason}::text END)
      WHERE turn_id=ANY(${turns}::uuid[]) AND status IN ('pending','running')`;
    yield* sql`UPDATE bot_routines SET last_outcome=${reason}, updated_at=now()
      WHERE id IN (SELECT routine_id FROM bot_turns WHERE id=ANY(${turns}::uuid[]))`;
    yield* sql`UPDATE bots SET status_line='', revision=revision+1, updated_at=now()
      WHERE id IN (SELECT bot_id FROM bot_turns WHERE id=ANY(${turns}::uuid[]))`;
  });
}
