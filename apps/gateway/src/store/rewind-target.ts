import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./errors.ts";
import type { ThreadRow, TurnRow } from "./rows.ts";
import { rewindBoundaries } from "./rewind-boundaries.ts";

/** Called under the thread admission lock, also for previews. Inherited turns belong to another thread. */
export const rewindTarget = (sql: SqlClient.SqlClient, owner: string, threadId: string, turnId: string) =>
  Effect.gen(function* () {
    const thread = (yield* sql<ThreadRow>`SELECT * FROM threads WHERE id=${threadId}::uuid
      AND owner_user_id=${owner}::uuid AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`)[0];

    if (!thread) return yield* Effect.fail(new NotFound("thread not found"));

    if (thread.runtime !== "worker" || thread.origin === "agent" || thread.remote_parent_ref || thread.schedule_id)
      return yield* Effect.fail(new Invalid("Edit from here is not available for automated threads."));

    if (thread.provider !== "codex" && thread.provider !== "claude")
      return yield* Effect.fail(new Invalid("Edit from here is not available for this agent."));

    if (!thread.provider_thread_id || !thread.worker_id)
      return yield* Effect.fail(new Invalid("Wait for the agent to finish creating this thread."));

    // A checkpoint belongs to the turn being edited, even when its conversation prefix comes from a fork.
    // Compare actual starts, not queue slots. A conversation rewind can hide the switch without undoing it.
    const [target] = yield* sql<TurnRow & { before_worktree_switch: boolean }>`
      SELECT u.*, ${thread.provider === "claude"} AND EXISTS (
        SELECT 1 FROM turns s WHERE s.thread_id=u.thread_id AND s.worktree_switch_source_cwd IS NOT NULL
          AND (s.first_seq IS NULL OR u.first_seq IS NULL OR s.first_seq>=u.first_seq)
      ) AS before_worktree_switch FROM turns u WHERE u.id=${turnId}::uuid AND u.thread_id=${threadId}::uuid`;

    if (!target || target.trigger !== "user" || target.rewind_id || target.withdrawn || !target.started_at)
      return yield* Effect.fail(new Invalid("Choose a sent message of your own in this thread."));

    if (target.input.shellCommand !== undefined)
      return yield* Effect.fail(new Invalid("Shell commands cannot be edited from history."));

    yield* rewindBoundaries(sql, threadId, target.queued_at, target.ordinal);

    const suffix = yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id=${threadId}::uuid
      AND ordinal>=${target.ordinal} AND rewind_id IS NULL ORDER BY ordinal`;

    let previous = (yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id=${threadId}::uuid
      AND ordinal<${target.ordinal} AND rewind_id IS NULL AND started_at IS NOT NULL ORDER BY ordinal DESC LIMIT 1`)[0];

    if (!previous && thread.fork_after_turn_id)
      previous = (yield* sql<TurnRow>`SELECT * FROM turns WHERE id=${thread.fork_after_turn_id}::uuid`)[0];

    if (previous && !previous.provider_turn_ref)
      return yield* Effect.fail(new Invalid("The agent did not record this rewind point. Choose an earlier message."));

    const tasks =
      (yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM thread_items
      WHERE thread_id=${threadId}::uuid AND type='background_task' AND status='in_progress'`)[0]?.count ?? 0;

    return {
      thread,
      target,
      previous,
      suffix,
      tasks,
      filesUnavailable:
        thread.provider !== "claude"
          ? "Files stay as they are."
          : target.before_worktree_switch
            ? "The thread switched worktrees after this message started."
            : "",
      running: suffix.some((turn) => turn.status === "running" || turn.status === "queued"),
    };
  });

export type RewindTarget = Effect.Success<ReturnType<typeof rewindTarget>>;
