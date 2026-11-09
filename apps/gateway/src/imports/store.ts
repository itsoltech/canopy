import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui, type ImportSnapshot } from "@canopy/contracts";
import type { JsonValue } from "@bufbuild/protobuf";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { InvalidError } from "../core/core-context.ts";
import { appendBase } from "./append.ts";
import { importTransaction } from "./locks.ts";
import { insertFreshItems } from "./run-items.ts";
import { insertLibraryItems, toUiLibrary, type LibraryRow, type NewLibraryItem } from "./library-store.ts";

/**
 * Runs and items of the CLI import (docs/import.md, "Model danych"); every query is owner-scoped. What changes them
 * is in transitions.ts, each in an importTransaction (locks.ts).
 */

export const ImportTargetJson = Schema.Struct({
  projectId: Schema.String,
  workspaceId: Schema.String,
  cwd: Schema.String,
  mode: Schema.Literals(["native", "history"]),
  cliVersion: Schema.optional(Schema.String),
});

export type ImportTargetJson = typeof ImportTargetJson.Type;

/** ImportSnapshot as an item keeps it (JSON): the import reads, and a copy holds, exactly this. */
export interface StoredSnapshot {
  readonly size: string;
  readonly modifiedMs: string;
  readonly prefixSha256: string;
  readonly historySize?: string;
  readonly historyPrefixSha256?: string;
}

export function storedSnapshot(snapshot: ImportSnapshot | undefined): StoredSnapshot {
  return {
    size: String(snapshot?.size ?? 0n),
    modifiedMs: String(snapshot?.modifiedMs ?? 0n),
    prefixSha256: snapshot?.prefixSha256 ?? "",
    ...(snapshot?.historyPrefixSha256 && {
      historySize: String(snapshot.historySize),
      historyPrefixSha256: snapshot.historyPrefixSha256,
    }),
  };
}

export interface ItemRow {
  readonly id: string;
  readonly run_id: string;
  readonly owner_user_id: string;
  readonly worker_id: string;
  readonly position: number;
  readonly agent_cli: string;
  readonly root_id: string;
  readonly native_id: string;
  readonly source_key: string;
  readonly title: string;
  readonly cwd: string;
  readonly snapshot: StoredSnapshot;
  readonly target: ImportTargetJson;
  readonly status: string;
  readonly cursor: string;
  readonly thread_id: string | null;
  readonly turns: number;
  readonly bytes_total: string;
  readonly bytes_done: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly warnings: readonly string[];
  /** Set for an append to an earlier import's thread (append.ts). */
  readonly base: JsonValue | null;
}

export interface RunRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly worker_id: string;
  readonly worker_name: string;
  readonly status: string;
  readonly mode: string;
  readonly already_imported: number;
  readonly error: string | null;
  readonly created_at: Date;
  readonly finished_at: Date | null;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly bytes_total: string;
  readonly bytes_done: string;
  readonly current: string | null;
  readonly library_done: number;
  readonly library_failed: number;
}

export interface NewItem {
  readonly agentCli: string;
  readonly rootId: string;
  readonly nativeId: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly cwd: string;
  readonly snapshot: StoredSnapshot;
  readonly target: ImportTargetJson;
  readonly bytes: bigint;
  /** Turns the CLI added after an earlier import: this item continues that item's thread from its cursor. */
  readonly continues?: {
    readonly itemId: string;
    readonly threadId: string;
    readonly cursor: string;
    readonly bytesDone: string;
  };
}

export const createRun = (
  sql: SqlClient.SqlClient,
  run: {
    id: string;
    ownerId: string;
    workerId: string;
    mode: string;
    alreadyImported: number;
    items: readonly NewItem[];
    library?: readonly NewLibraryItem[];
  },
) =>
  // Appends lock the threads they continue and those threads' items (the one they supersede, too).
  importTransaction(sql, { threads: run.items.flatMap((i) => (i.continues ? [i.continues.threadId] : [])) }, () =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO import_runs (id, owner_user_id, worker_id, status, mode, already_imported)
                 VALUES (${run.id}::uuid, ${run.ownerId}::uuid, ${run.workerId}::uuid, 'running', ${run.mode}, ${run.alreadyImported})`;
      yield* insertLibraryItems(sql, run, run.library ?? []);

      if (!run.items.some((item) => item.continues)) {
        yield* insertFreshItems(sql, run, run.items);

        return;
      }

      for (const [position, item] of run.items.entries()) {
        const continues = item.continues;

        if (continues) {
          // With the thread locked, a message sent meanwhile either landed first (the append is refused) or waits.
          const own = yield* sql<{ own: boolean }>`
            SELECT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.trigger <> 'import') AS own
              FROM threads t WHERE t.id = ${continues.threadId}::uuid`;

          const superseded = yield* sql`
            UPDATE import_items SET status = 'superseded', updated_at = now()
             WHERE id = ${continues.itemId}::uuid AND status = 'done' RETURNING id`;

          if (own[0]?.own !== false || superseded.length === 0)
            return yield* Effect.fail(new InvalidError("Some of these threads continued in Canopy. Scan again."));
        }

        const base = continues ? yield* appendBase(sql, continues.threadId) : null;

        yield* sql`
          INSERT INTO import_items (id, run_id, owner_user_id, worker_id, position, agent_cli, root_id, native_id, source_key,
                                    title, cwd, snapshot, target, status, bytes_total, thread_id, cursor, bytes_done, base)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${run.id}::uuid, ${run.ownerId}::uuid, ${run.workerId}::uuid, ${position},
                  ${item.agentCli}, ${item.rootId}, ${item.nativeId}, ${item.sourceKey}, ${item.title}, ${item.cwd},
                  ${JSON.stringify(item.snapshot)}::jsonb, ${JSON.stringify(item.target)}::jsonb,
                  ${continues ? "importing" : "pending"}, ${item.bytes}, ${continues?.threadId ?? null}::uuid,
                  ${continues?.cursor ?? ""}, ${continues?.bytesDone ?? "0"},
                  ${base === null ? null : JSON.stringify(base)}::jsonb)`;
      }
    }),
  );

const RUN_COLUMNS = `
  r.*, w.name AS worker_name,
  (SELECT count(*)::int FROM import_items i WHERE i.run_id = r.id) AS total,
  (SELECT count(*)::int FROM import_items i WHERE i.run_id = r.id AND i.status = 'done') AS done,
  (SELECT count(*)::int FROM import_items i WHERE i.run_id = r.id AND i.status = 'failed') AS failed,
  (SELECT count(*)::int FROM import_items i WHERE i.run_id = r.id AND i.status = 'cancelled') AS cancelled,
  (SELECT coalesce(sum(i.bytes_total), 0)::text FROM import_items i WHERE i.run_id = r.id AND i.status <> 'cancelled') AS bytes_total,
  (SELECT coalesce(sum(CASE WHEN i.status = 'done' THEN i.bytes_total ELSE i.bytes_done END), 0)::text
     FROM import_items i WHERE i.run_id = r.id) AS bytes_done,
  (SELECT i.title FROM import_items i WHERE i.run_id = r.id AND i.status = 'importing' ORDER BY i.position LIMIT 1) AS current,
  (SELECT count(*)::int FROM import_library_items l WHERE l.run_id = r.id AND l.status = 'done') AS library_done,
  (SELECT count(*)::int FROM import_library_items l WHERE l.run_id = r.id AND l.status = 'failed') AS library_failed`;

export const runs = (sql: SqlClient.SqlClient, ownerId: string, runId?: string) =>
  sql<RunRow>`SELECT ${sql.literal(RUN_COLUMNS)} FROM import_runs r JOIN workers w ON w.id = r.worker_id
               WHERE r.owner_user_id = ${ownerId}::uuid AND (${runId ?? null}::uuid IS NULL OR r.id = ${runId ?? null}::uuid)
               ORDER BY r.created_at DESC LIMIT 50`;

export const items = (sql: SqlClient.SqlClient, runId: string) =>
  sql<ItemRow>`SELECT * FROM import_items WHERE run_id = ${runId}::uuid ORDER BY position`;

export const nextItem = (sql: SqlClient.SqlClient, runId: string) =>
  sql<ItemRow>`SELECT * FROM import_items WHERE run_id = ${runId}::uuid AND status IN ('importing', 'pending')
               ORDER BY status = 'importing' DESC, position LIMIT 1`;

export const setRunStatus = (sql: SqlClient.SqlClient, runId: string, status: string, error: string | null = null) =>
  sql`UPDATE import_runs SET status = ${status}, error = ${error}, updated_at = now(),
             finished_at = CASE WHEN ${status} IN ('completed', 'failed', 'cancelled', 'undone') THEN now() END
       WHERE id = ${runId}::uuid`;

/** Live imports of this owner on a worker, by `${agent_cli}:${native_id}` (a deleted thread frees its source). */
export interface KnownSourceRow {
  readonly id: string;
  readonly agent_cli: string;
  readonly native_id: string;
  readonly root_id: string;
  readonly thread_id: string | null;
  readonly status: string;
  readonly bytes_done: string;
  readonly cursor: string;
  readonly target: ImportTargetJson;
  /** The thread took turns in Canopy: its copy and the CLI's file went separate ways. */
  readonly own_turns: boolean;
}

export const knownSources = (sql: SqlClient.SqlClient, ownerId: string, workerId: string) =>
  sql<KnownSourceRow>`
    SELECT i.id, i.agent_cli, i.native_id, i.root_id, i.thread_id, i.status, i.bytes_done, i.cursor, i.target,
           EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = i.thread_id AND u.trigger <> 'import') AS own_turns
      FROM import_items i
      LEFT JOIN threads t ON t.id = i.thread_id
     WHERE i.owner_user_id = ${ownerId}::uuid AND i.worker_id = ${workerId}::uuid
       AND i.status IN ('pending', 'importing', 'done', 'failed') AND (t.id IS NULL OR t.deleted_at IS NULL)`;

export function toUiRun(row: RunRow, rows: readonly ItemRow[] = [], library: readonly LibraryRow[] = []): ui.ImportRun {
  return create(ui.ImportRunSchema, {
    id: row.id,
    workerId: row.worker_id,
    workerName: row.worker_name,
    status: row.status,
    mode: row.mode,
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.finished_at && { finishedAt: timestampFromDate(new Date(row.finished_at)) }),
    total: row.total,
    done: row.done,
    failed: row.failed,
    cancelled: row.cancelled,
    alreadyImported: row.already_imported,
    bytesTotal: BigInt(row.bytes_total),
    bytesDone: BigInt(row.bytes_done),
    error: row.error ?? "",
    current: row.current ?? "",
    library: library.map(toUiLibrary),
    items: rows.map((i) =>
      create(ui.ImportItemSchema, {
        id: i.id,
        agentCli: i.agent_cli,
        title: i.title,
        status: i.status,
        threadId: i.thread_id ?? "",
        error: i.error ?? "",
        turns: i.turns,
        bytesTotal: BigInt(i.bytes_total),
        bytesDone: BigInt(i.status === "done" ? i.bytes_total : i.bytes_done),
        warnings: [...i.warnings],
        cwd: i.cwd,
        continueMode: i.target.mode,
      }),
    ),
  });
}
