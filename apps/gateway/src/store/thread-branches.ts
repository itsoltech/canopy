import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { NoticeLevel, ThreadEventSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertEvent } from "./ingest-events.ts";
import { Invalid } from "./errors.ts";
import type { ThreadRow, TurnRow } from "./rows.ts";

/** Resolve checkout membership on the worker without spawning git for every thread. */
export function branchCheckoutPaths(worker: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{
      cwd: string;
    }>`SELECT DISTINCT cwd FROM threads WHERE worker_id=${worker}::uuid AND cwd IS NOT NULL`;

    return rows.map((row) => row.cwd);
  });
}

/** Held through the worker acknowledgement, in the same transaction as notices and the new HEAD. */
export type BranchCheckout = Pick<ThreadRow, "worker_id" | "worktree_id" | "cwd"> & { id?: string };

export function lockBranchCheckout(owner: string, target: BranchCheckout, paths: readonly string[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Same order as queue/lifecycle admission. Lock all threads of this checkout, including subdirectories.
    const rows = yield* sql<ThreadRow>`SELECT * FROM threads
      WHERE worker_id=${target.worker_id}::uuid AND (
        id=${target.id ?? null}::uuid OR
        worktree_id=${target.worktree_id ?? null}::uuid OR
        cwd=ANY(${paths}::text[])
      ) ORDER BY id FOR UPDATE`;

    const current = rows.find((row) => row.id === target.id);

    if (
      target.id &&
      (!current ||
        current.cwd !== target.cwd ||
        current.deleted_at ||
        current.archived_at ||
        current.worktree_id !== target.worktree_id)
    )
      return yield* Effect.fail(new Invalid("The working directory changed. Refresh the thread."));

    if (rows.some((row) => row.owner_user_id !== owner))
      return yield* Effect.fail(new Invalid("Another owner's thread uses this directory. Choose a separate worktree."));
    const ids = rows.map((row) => row.id);

    const busy = yield* sql<{ has_goal: boolean }>`SELECT id,
      EXISTS (SELECT 1 FROM goals g WHERE g.thread_id=t.id AND g.status NOT IN ('achieved','cancelled')) AS has_goal
      FROM threads t WHERE t.id=ANY(${ids}::uuid[]) AND (
      t.status IN ('creating','running','waiting_input') OR
      EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('queued','running')) OR
      EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id=t.id AND i.status='pending') OR
      EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.type='background_task' AND i.status='in_progress') OR
      EXISTS (SELECT 1 FROM goals g WHERE g.thread_id=t.id AND g.status NOT IN ('achieved','cancelled')) OR
      EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id=t.id AND c.status IN ('pending','delivered')
        AND c.kind IN ('startTurn','createThread','setGoal') AND c.expires_at>now())) LIMIT 1`;

    if (busy[0]?.has_goal)
      return yield* Effect.fail(
        new Invalid("A thread in this directory has an open goal. Clear it before switching branches."),
      );

    if (busy.length)
      return yield* Effect.fail(new Invalid("A thread is using this directory. Wait for its turn to finish."));

    return ids;
  });
}

/** Consumed in the same transaction that durably queues the next turn's input. */
export function takeBranchNote(
  threadId: string,
  turnId: string,
  input: Pick<TurnRow["input"], "text" | "message" | "note" | "delivered" | "branchNote">,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE threads SET settings=settings-'branchNote' WHERE id=${threadId}::uuid`;
    yield* sql`UPDATE turns SET input=input || ${JSON.stringify(input)}::jsonb WHERE id=${turnId}::uuid`;
  });
}

export function branchSwitchNotices(ids: readonly string[], branch: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const note = `The user switched this checkout to branch ${branch}. Check the files before continuing.`;

    const rows = yield* sql<{ id: string; last_seq: bigint }>`UPDATE threads SET last_seq=last_seq+1,
      settings=jsonb_set(settings, '{branchNote}', ${JSON.stringify(note)}::jsonb)
      WHERE id=ANY(${ids}::uuid[]) AND deleted_at IS NULL RETURNING id, last_seq`;

    const stored = [];

    for (const row of rows) {
      const event = create(ThreadEventSchema, {
        eventId: Bun.randomUUIDv7(),
        threadId: row.id,
        occurredAt: timestampNow(),
        body: {
          case: "notice",
          value: { level: NoticeLevel.INFO, code: "branch_switched", message: `Branch switched to ${branch} by you` },
        },
      });

      const seq = BigInt(row.last_seq);
      yield* insertEvent(sql, row.id, seq, event, "gateway");
      stored.push({ threadId: row.id, seq, event });
    }

    return stored;
  });
}

/** Persist a composer switch even when this checkout has no thread yet. */
export function saveWorkspaceBranch(owner: string, workspace: string, worktree: string, branch: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (worktree) {
      yield* sql`UPDATE worktrees SET branch=${branch}, detached_commit=''
        WHERE id=${worktree}::uuid AND owner_user_id=${owner}::uuid AND workspace_id=${workspace}::uuid
        AND removed_at IS NULL`;
    } else {
      yield* sql`INSERT INTO checkout_heads (workspace_id,branch,detached_commit)
        VALUES (${workspace}::uuid,${branch},'') ON CONFLICT (workspace_id) DO UPDATE
        SET branch=EXCLUDED.branch,detached_commit='',updated_at=now()`;
    }
  });
}

/** Queue and cleanup take thread locks before this availability fence. */
export function lockBranchWorktree(owner: string, id: string, cwd: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{ path: string; removal_token: string | null }>`SELECT path,removal_token FROM worktrees
      WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid AND removed_at IS NULL FOR UPDATE`;

    if (!rows[0] || rows[0].path !== cwd || rows[0].removal_token)
      return yield* Effect.fail(new Invalid("Worktree unavailable. Refresh and choose a worktree."));
  });
}
