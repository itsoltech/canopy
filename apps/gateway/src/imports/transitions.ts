import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { importTransaction, type Locks } from "./locks.ts";

/**
 * Changes of import runs and items (docs/import.md, "Przebieg"), each one transaction through importTransaction:
 * what it may change is locked before it writes (locks.ts), and it writes nothing outside that.
 */

export const setRunStatus = (sql: SqlClient.SqlClient, runId: string, status: string, error: string | null = null) =>
  sql`UPDATE import_runs SET status = ${status}, error = ${error}, updated_at = now(),
             finished_at = CASE WHEN ${status} IN ('completed', 'failed', 'cancelled', 'undone') THEN now() END
       WHERE id = ${runId}::uuid`;

/** The run was cancelled or undone while one of its threads was being imported; nothing more is written for it. */
export class ImportStopped extends Error {
  constructor() {
    super("the import was stopped");
  }
}

/** The item is still being imported in a running run (both locked by the caller), or ImportStopped. */
export const fenceItem = (locks: Locks, itemId: string) => {
  const item = locks.items.get(itemId);
  const run = item ? locks.runs.get(item.run_id) : undefined;

  return run?.status === "running" && item && ["pending", "importing"].includes(item.status)
    ? Effect.void
    : Effect.fail(new ImportStopped());
};

/**
 * The runner's own transitions (pause, finish) happen only while the run is running, so a Cancel or Undo that got
 * there first stays terminal.
 */
export const runnerRunStatus = (sql: SqlClient.SqlClient, runId: string, status: string, error: string | null = null) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      if (locks.runs.get(runId)?.status !== "running") return false;
      yield* setRunStatus(sql, runId, status, error);

      return true;
    }),
  );

/** A paused run continues (its worker is back), unless it was cancelled or undone meanwhile. */
export const resumePaused = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.map(
    sql`UPDATE import_runs SET status = 'running', error = NULL, updated_at = now()
         WHERE id = ${runId}::uuid AND status = 'paused' RETURNING id`,
    (rows) => rows.length > 0,
  );

/** Resume from the UI: failed threads again and the run running, only from a state that allows it. */
export const resumeRun = (sql: SqlClient.SqlClient, ownerId: string, runId: string) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      const run = locks.runs.get(runId);

      if (run?.owner_user_id !== ownerId || !["paused", "completed", "failed"].includes(run.status)) return false;
      yield* sql`
        UPDATE import_items SET status = CASE WHEN thread_id IS NULL THEN 'pending' ELSE 'importing' END, error = NULL,
               updated_at = now()
         WHERE run_id = ${runId}::uuid AND status = 'failed'`;
      yield* setRunStatus(sql, runId, "running");

      return true;
    }),
  );

/**
 * The item failed, unless its run was stopped meanwhile (then nothing changes and `failed` is false). A thread that
 * got no turns is not left in the sidebar (Retry makes a new one): `dropped` names it.
 */
export const failItem = (sql: SqlClient.SqlClient, itemId: string, error: string) =>
  importTransaction(sql, { items: [itemId] }, (locks) =>
    Effect.gen(function* () {
      const item = locks.items.get(itemId);

      if (!item || locks.runs.get(item.run_id)?.status !== "running" || !["pending", "importing"].includes(item.status))
        return { failed: false, dropped: undefined };
      yield* sql`
        UPDATE import_items SET status = 'failed', error = ${error}, updated_at = now(), attempts = attempts + 1
         WHERE id = ${itemId}::uuid`;

      return { failed: true, dropped: yield* dropEmpty(sql, item.id, item.thread_id) };
    }),
  );

/** Within a transaction that locked the item and its thread: an empty thread goes, the item lets go of it. */
export const dropEmpty = (sql: SqlClient.SqlClient, itemId: string, threadId: string | null) =>
  Effect.gen(function* () {
    if (!threadId) return undefined;
    const turns = yield* sql`SELECT 1 FROM turns WHERE thread_id = ${threadId}::uuid LIMIT 1`;

    if (turns.length > 0) return undefined;
    yield* sql`UPDATE threads SET deleted_at = now() WHERE id = ${threadId}::uuid AND deleted_at IS NULL`;
    yield* sql`UPDATE import_items SET thread_id = NULL WHERE id = ${itemId}::uuid`;

    return threadId;
  });

/** The item is done, unless its run was stopped meanwhile (then false). */
export const finishItem = (sql: SqlClient.SqlClient, itemId: string) =>
  importTransaction(sql, { items: [itemId] }, (locks) =>
    Effect.gen(function* () {
      yield* fenceItem(locks, itemId);
      yield* sql`UPDATE import_items SET status = 'done', error = NULL, updated_at = now() WHERE id = ${itemId}::uuid`;

      return true;
    }),
  ).pipe(
    Effect.catchIf(
      (e) => e instanceof ImportStopped,
      () => Effect.succeed(false),
    ),
  );

/**
 * Cancels a run in one transaction, with or without a runner: pending threads are left out, a thread being imported
 * is removed (it holds only what the import wrote) and its source is free again. Returns the threads that changed.
 */
export const cancelRun = (sql: SqlClient.SqlClient, ownerId: string, runId: string) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      const run = locks.runs.get(runId);

      if (run?.owner_user_id !== ownerId || !["running", "paused"].includes(run.status)) return [];
      yield* setRunStatus(sql, runId, "cancelled");
      yield* sql`UPDATE import_items SET status = 'cancelled', updated_at = now() WHERE run_id = ${runId}::uuid AND status = 'pending'`;

      const removed = yield* sql<{ thread_id: string | null }>`
        UPDATE import_items SET status = 'cancelled', updated_at = now()
         WHERE run_id = ${runId}::uuid AND status = 'importing' RETURNING thread_id`;

      const threads = removed.flatMap((r) => (r.thread_id ? [r.thread_id] : []));

      if (threads.length > 0)
        yield* sql`UPDATE threads SET deleted_at = now() WHERE id = ANY(${threads}::uuid[]) AND deleted_at IS NULL`;

      return threads;
    }),
  );

/**
 * Undo of a finished run in one transaction: its items and the run are undone (the sources are free again) and the
 * threads it created are returned for the caller to delete. False when the run is not finished (or not the owner's).
 */
export const undoRun = (sql: SqlClient.SqlClient, ownerId: string, runId: string) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      const run = locks.runs.get(runId);

      if (run?.owner_user_id !== ownerId || !["completed", "failed", "cancelled"].includes(run.status))
        return { undone: false, created: [] };

      const created = yield* sql<{ thread_id: string }>`
        SELECT i.thread_id FROM import_items i JOIN threads t ON t.id = i.thread_id
         WHERE i.run_id = ${runId}::uuid AND t.deleted_at IS NULL`;

      yield* sql`UPDATE import_items SET status = 'undone', updated_at = now() WHERE run_id = ${runId}::uuid AND status <> 'cancelled'`;
      yield* setRunStatus(sql, runId, "undone");

      return { undone: true, created: created.map((r) => r.thread_id) };
    }),
  );

/** Items whose thread the owner deleted no longer hold their source. */
export const releaseDeleted = (sql: SqlClient.SqlClient, ownerId: string, workerId: string) =>
  Effect.gen(function* () {
    const held = yield* sql<{ id: string }>`
      SELECT i.id FROM import_items i JOIN threads t ON t.id = i.thread_id
       WHERE t.deleted_at IS NOT NULL AND i.owner_user_id = ${ownerId}::uuid AND i.worker_id = ${workerId}::uuid
         AND i.status IN ('done', 'failed', 'importing')`;

    if (held.length === 0) return;
    const ids = held.map((r) => r.id);

    yield* importTransaction(
      sql,
      { items: ids },
      () => sql`
        UPDATE import_items i SET status = 'undone', updated_at = now() FROM threads t
         WHERE t.id = i.thread_id AND t.deleted_at IS NOT NULL AND i.id = ANY(${ids}::uuid[])
           AND i.status IN ('done', 'failed', 'importing')`,
    );
  });
