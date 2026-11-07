import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { JsonValue } from "@bufbuild/protobuf";
import { restoreOwner, revertAppend, ThreadContinued, toHistory } from "./append.ts";
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
 * got no turns is not left in the sidebar (Retry makes a new one): `dropped` names it. A native thread without its
 * session takes no turns (the database refuses them too): until Retry adopts it, it continues in a new one.
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

      if (item.thread_id)
        yield* sql`UPDATE thread_imports SET mode = 'history' WHERE thread_id = ${item.thread_id}::uuid AND mode = 'native'`;

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

/** The thread took a conversation of its own meanwhile: the adopted session is not set over it. */
export class SessionTaken extends Error {
  constructor() {
    super("This thread already continues another conversation.");
  }
}

/**
 * The item is done, unless its run was stopped meanwhile (then false). A natively continued thread gets its CLI
 * session in the same transaction, only if it has none or the same one.
 */
export const finishItem = (
  sql: SqlClient.SqlClient,
  itemId: string,
  adopted?: { readonly threadId: string; readonly sessionId: string },
) =>
  importTransaction(sql, { items: [itemId], threads: adopted ? [adopted.threadId] : [] }, (locks) =>
    Effect.gen(function* () {
      yield* fenceItem(locks, itemId);

      if (adopted) {
        const set = yield* sql`
          UPDATE threads SET provider_thread_id = ${adopted.sessionId} WHERE id = ${adopted.threadId}::uuid
             AND (provider_thread_id IS NULL OR provider_thread_id = ${adopted.sessionId}) RETURNING id`;

        if (set.length === 0) return yield* Effect.fail(new SessionTaken());
        // Continues natively again (a failed attempt had turned it to history).
        yield* sql`UPDATE thread_imports SET mode = 'native' WHERE thread_id = ${adopted.threadId}::uuid`;
      }

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
 * At the end of the source: an item whose thread got no turns (a session without conversation) is done with a
 * warning and its empty thread goes, in one transaction. `empty` is false when the thread has turns (the caller
 * finishes it as usual) or the run was stopped meanwhile.
 */
export const finishEmpty = (sql: SqlClient.SqlClient, itemId: string, threadId: string) =>
  importTransaction(sql, { items: [itemId], threads: [threadId] }, (locks) =>
    Effect.gen(function* () {
      yield* fenceItem(locks, itemId);
      const turns = yield* sql`SELECT 1 FROM turns WHERE thread_id = ${threadId}::uuid LIMIT 1`;

      if (turns.length > 0) return { empty: false, dropped: undefined };
      yield* sql`
        UPDATE import_items SET warnings = warnings || '["Nothing to import"]'::jsonb, status = 'done', error = NULL,
               updated_at = now()
         WHERE id = ${itemId}::uuid`;

      return { empty: true, dropped: yield* dropEmpty(sql, itemId, threadId) };
    }),
  ).pipe(
    Effect.catchIf(
      (e) => e instanceof ImportStopped,
      () => Effect.succeed({ empty: true, dropped: undefined }),
    ),
  );

/** The session could not be adopted: the thread stays as history (it continues in a new thread), with the reason. */
export const adoptionFailed = (sql: SqlClient.SqlClient, itemId: string, threadId: string, reason: string) =>
  importTransaction(sql, { items: [itemId], threads: [threadId] }, () =>
    Effect.gen(function* () {
      yield* sql`UPDATE thread_imports SET mode = 'history' WHERE thread_id = ${threadId}::uuid`;
      yield* sql`UPDATE import_items SET warnings = warnings || ${JSON.stringify([reason])}::jsonb,
                        target = jsonb_set(target, '{mode}', '"history"') WHERE id = ${itemId}::uuid`;
    }),
  );

/** toHistory in its own transaction (the thread and its items locked). */
export const threadToHistory = (sql: SqlClient.SqlClient, threadId: string, reason: string) =>
  importTransaction(sql, { threads: [threadId] }, () => toHistory(sql, threadId, reason));

/**
 * Cancels a run in one transaction, with or without a runner: pending threads are left out, a new thread being
 * imported is removed (it holds only what the import wrote) and its source is free again; an append puts its thread
 * back as the earlier import left it. Returns the threads that changed.
 */
export const cancelRun = (sql: SqlClient.SqlClient, ownerId: string, runId: string) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      const run = locks.runs.get(runId);

      if (run?.owner_user_id !== ownerId || !["running", "paused"].includes(run.status)) return [];
      yield* setRunStatus(sql, runId, "cancelled");
      yield* sql`UPDATE import_items SET status = 'cancelled', updated_at = now() WHERE run_id = ${runId}::uuid AND status = 'pending'`;

      const removed = yield* sql<{ id: string; thread_id: string | null; base: JsonValue | null }>`
        UPDATE import_items SET status = 'cancelled', updated_at = now()
         WHERE run_id = ${runId}::uuid AND status = 'importing' RETURNING id, thread_id, base`;

      const threads: string[] = [];
      const reverted: string[] = [];

      for (const item of removed) {
        if (!item.thread_id) continue;
        const threadId = item.thread_id;

        // An append keeps the history imported before; only what it added goes. Something else happened in the
        // thread after the append (it cannot while importing): kept as it is then.
        const back = yield* revertAppend(sql, item).pipe(
          Effect.catchIf(
            (e) => e instanceof ThreadContinued,
            () => restoreOwner(sql, threadId).pipe(Effect.as(true)),
          ),
        );

        (back ? reverted : threads).push(threadId);
      }

      if (threads.length > 0)
        yield* sql`UPDATE threads SET deleted_at = now() WHERE id = ANY(${threads}::uuid[]) AND deleted_at IS NULL`;

      // Every thread that changed (removed or put back), for the UI.
      return [...threads, ...reverted];
    }),
  );

/**
 * Undo of a finished run in one transaction: threads it appended to go back to what the earlier import left
 * (ThreadContinued fails the whole undo when one went on after it; a natively continued one whose copy already took
 * the appended turns continues in a new thread), its items and the run are undone (the sources are free again), and
 * the threads it created are returned for the caller to delete. `undone` is false when the run is not finished.
 */
export const undoRun = (sql: SqlClient.SqlClient, ownerId: string, runId: string) =>
  importTransaction(sql, { runs: [runId] }, (locks) =>
    Effect.gen(function* () {
      const run = locks.runs.get(runId);

      if (run?.owner_user_id !== ownerId || !["completed", "failed", "cancelled"].includes(run.status))
        return { undone: false, created: [], reverted: [] };

      // A later import continued one of its threads: undoing this one would take that one's history too.
      if ([...locks.items.values()].some((i) => i.run_id === runId && i.status === "superseded"))
        return yield* Effect.fail(new ThreadContinued());

      const appends = yield* sql<{ id: string; thread_id: string | null; base: JsonValue | null }>`
        SELECT id, thread_id, base FROM import_items
         WHERE run_id = ${runId}::uuid AND base IS NOT NULL AND status IN ('done', 'failed') ORDER BY id`;

      const reverted: string[] = [];

      for (const item of appends) {
        // The append lets go of the source first: the earlier import takes it back.
        yield* sql`UPDATE import_items SET status = 'undone', updated_at = now() WHERE id = ${item.id}::uuid`;

        if (!item.thread_id || !(yield* revertAppend(sql, item))) continue;
        reverted.push(item.thread_id);
        yield* toHistory(sql, item.thread_id, "Continues in a new thread: its CLI copy has turns that were removed.");
      }

      const created = yield* sql<{ thread_id: string }>`
        SELECT i.thread_id FROM import_items i JOIN threads t ON t.id = i.thread_id
         WHERE i.run_id = ${runId}::uuid AND t.deleted_at IS NULL AND i.base IS NULL`;

      yield* sql`UPDATE import_items SET status = 'undone', updated_at = now() WHERE run_id = ${runId}::uuid AND status <> 'cancelled'`;
      yield* setRunStatus(sql, runId, "undone");

      return { undone: true, created: created.map((r) => r.thread_id), reverted };
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
