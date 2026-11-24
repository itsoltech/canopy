import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { callerMode } from "./agent-bus-queries.ts";
import { Invalid } from "./errors.ts";
import { lockedOwnerModule, moduleDisabledMessage } from "./module-access.ts";
import type { ThreadRow } from "./rows.ts";
import { SANDBOX_DERIVATION_UNAVAILABLE, threadSandbox } from "./thread-sandbox.ts";

export interface WorktreeSwitchSource {
  owner: string;
  workerId: string;
  threadId: string;
  turnId: string;
  expectedCwd: string;
  expectedWorktreeId: string | null;
}

/** Check authority before Git work and reacquire it for the final compare-and-set. Call inside a transaction. */
export function lockThreadWorktreeSource(source: WorktreeSwitchSource) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!(yield* lockedOwnerModule(sql, source.owner, "threads")))
      return yield* Effect.fail(new Invalid(moduleDisabledMessage("threads")));

    const [thread] = yield* sql<ThreadRow>`SELECT * FROM lock_thread_worktree_source(
      ${source.owner}::uuid,${source.workerId}::uuid,${source.threadId}::uuid,${source.turnId}::uuid,
      ${source.expectedCwd},${source.expectedWorktreeId}::uuid)`;

    if (!thread)
      return yield* Effect.fail(
        new Invalid("The turn has ended or its working directory changed. Switch from the next running turn."),
      );

    if (thread.provider === "grok")
      return yield* Effect.fail(new Invalid("Grok cannot resume a thread in a different working directory."));

    if (threadSandbox(thread)) return yield* Effect.fail(new Invalid(SANDBOX_DERIVATION_UNAVAILABLE));

    if ((yield* callerMode(sql, source, thread)) === "read_only")
      return yield* Effect.fail(new Invalid("Read-only turns cannot switch worktrees."));

    const [busy] = yield* sql<{ goal: boolean; tasks: boolean }>`SELECT
      EXISTS (SELECT 1 FROM goals WHERE thread_id=${thread.id}::uuid AND status NOT IN ('achieved','cancelled')) AS goal,
      EXISTS (SELECT 1 FROM thread_items WHERE thread_id=${thread.id}::uuid AND type='background_task'
        AND status='in_progress') AS tasks`;

    if (busy?.goal)
      return yield* Effect.fail(new Invalid("Finish or clear this thread’s goal before switching worktrees."));

    if (busy?.tasks)
      return yield* Effect.fail(new Invalid("Finish this thread’s background tasks before switching worktrees."));

    return thread;
  });
}

export function switchThreadWorktree(
  input: WorktreeSwitchSource & { destinationWorktreeId: string | null; expectedWorkspaceRoot: string },
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockThreadWorktreeSource(input);

        const [row] = yield* sql<{ cwd: string; worktree_id: string | null; branch: string; detached_commit: string }>`
          SELECT * FROM switch_thread_worktree(${input.owner}::uuid,${input.workerId}::uuid,${input.threadId}::uuid,
            ${input.turnId}::uuid,${input.expectedCwd},${input.expectedWorktreeId}::uuid,${input.destinationWorktreeId}::uuid,${input.expectedWorkspaceRoot})`;

        if (!row)
          return yield* Effect.fail(new Invalid("This worktree is unavailable. Refresh and choose a worktree."));

        return {
          cwd: row.cwd,
          worktreeId: row.worktree_id,
          branch: row.detached_commit ? "" : row.branch,
          detachedCommit: row.detached_commit,
        };
      }),
    );
  });
}
