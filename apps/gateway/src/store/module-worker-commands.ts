import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { outboxStore } from "./outbox.ts";
import { stopThreadWorkerResources } from "./thread-cleanup.ts";

export const THREADS_DISABLED_REASON = "Threads was turned off";

/** Both fences run under the settings writer's exclusive owner lock, before turns become terminal. */
export function fenceThreadWorkerCommands(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    const threads = yield* sql<{ id: string }>`SELECT id FROM threads WHERE owner_user_id = ${owner}::uuid
      AND worker_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id FOR UPDATE`;

    const ids = threads.map((thread) => thread.id);
    const { turns } = yield* stopThreadWorkerResources(sql, outboxStore(sql).enqueueCommand, ids, true);
    yield* sql`UPDATE turns SET status = 'interrupted', interrupt_source = 'system',
      interrupt_reason = ${THREADS_DISABLED_REASON}, completed_at = now()
      WHERE id = ANY(${turns.map((turn) => turn.id)}::uuid[]) AND status IN ('queued','running')`;
    yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE thread_id = ANY(${ids}::uuid[])
      AND status = 'queued' AND trigger = 'recovery' AND resume_reason = 'worker_oom'`;
    yield* sql`UPDATE threads SET status = 'idle' WHERE id = ANY(${ids}::uuid[]) AND status IN ('running','waiting_input')`;
  });
}

/** A caller holds the owner module lock or has locked the bot before fencing its worker commands. */
export function fenceBotWorkerCommands(sql: SqlClient.SqlClient, owner: string, botId?: string) {
  return Effect.gen(function* () {
    const active = yield* sql<{ worker_id: string; bot_id: string; turn_id: string; command_id: string }>`
      SELECT h.worker_id, h.bot_id, h.turn_id, h.command_id FROM bot_harness_turns h
      JOIN bots b ON b.id = h.bot_id WHERE b.owner_user_id = ${owner}::uuid AND h.outcome IS NULL
        AND (${botId ?? null}::uuid IS NULL OR h.bot_id = ${botId ?? null}::uuid)
      ORDER BY b.id, h.turn_id`;

    yield* sql`UPDATE worker_commands SET status = 'expired', completed_at = now()
      WHERE id = ANY(${active.map((row) => row.command_id)}::uuid[]) AND status IN ('pending','delivered')`;
    const outbox = outboxStore(sql);

    for (const turn of active)
      yield* outbox.enqueueCommand({
        workerId: turn.worker_id,
        ttlSeconds: 365 * 86400,
        command: { kind: { case: "interruptBotTurn", value: { threadId: turn.bot_id, turnId: turn.turn_id } } },
      });

    return [...new Set(active.map((row) => row.worker_id))];
  });
}
