import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { nextStoredCronRun } from "../core/cron.ts";
import type { InteractionRow } from "./rows.ts";
import { writeInteractionTimeline } from "./interaction-timeline.ts";
import type { ScheduleRow } from "./agent-bus-types.ts";
import { suspendThreadSteers } from "./module-steers.ts";
import { fenceThreadWorkerCommands } from "./module-worker-commands.ts";

/** The settings write holds the owner's exclusive module lock until these changes commit. */
export function applyThreadModuleTransition(sql: SqlClient.SqlClient, owner: string, enabled: boolean) {
  return Effect.gen(function* () {
    yield* sql`UPDATE schedules s SET lease_owner = NULL, lease_until = NULL
        FROM projects p WHERE p.id = s.project_id AND p.owner_user_id = ${owner}::uuid
          AND s.status = 'active' AND s.lease_owner IS NOT NULL`;

    if (!enabled) {
      yield* fenceThreadWorkerCommands(sql, owner);

      const expired =
        yield* sql<InteractionRow>`UPDATE interaction_requests q SET status = 'expired', answered_at = now()
        FROM turns u JOIN threads t ON t.id = u.thread_id WHERE q.turn_id = u.id AND t.owner_user_id = ${owner}::uuid
        AND u.status = 'interrupted' AND q.status = 'pending' AND (q.question_call_id IS NULL OR q.question_wait)
        RETURNING q.*`;

      for (const interaction of expired) yield* writeInteractionTimeline(sql, interaction);
      yield* sql`UPDATE thread_secrets s SET status = 'expired', ciphertext = NULL, key_id = NULL,
        file_path = NULL, revision = revision + 1 FROM threads t WHERE t.id = s.thread_id
        AND t.owner_user_id = ${owner}::uuid AND s.status IN ('pending', 'saved')`;
      yield* suspendThreadSteers(sql, owner);
      yield* sql`UPDATE goals g SET status = 'paused', resume_after_module_enable = TRUE, updated_at = now()
        FROM threads t WHERE t.id = g.thread_id AND t.owner_user_id = ${owner}::uuid AND g.status = 'active'`;

      return;
    }

    const now = new Date();

    const due = yield* sql<ScheduleRow>`SELECT s.* FROM schedules s JOIN projects p ON p.id = s.project_id
      WHERE p.owner_user_id = ${owner}::uuid AND s.status = 'active' AND s.kind = 'recurring' AND s.next_run_at <= ${now}
      ORDER BY s.id FOR UPDATE OF s`;

    for (const schedule of due) {
      const next = nextStoredCronRun(schedule.cron, schedule.timezone, now);
      const finished = !next || (schedule.until && next > new Date(schedule.until));
      yield* sql`UPDATE schedules SET next_run_at = ${finished ? null : next}, occurrence_at = NULL,
        status = ${finished ? "completed" : "active"}, updated_at = now() WHERE id = ${schedule.id}::uuid`;
    }
  });
}
