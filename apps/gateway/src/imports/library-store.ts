import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { importTransaction } from "./locks.ts";

/** Settings and library items of import runs (docs/import.md, "Ustawienia i biblioteka"); all owner-scoped. */

export interface LibraryRow {
  readonly id: string;
  readonly run_id: string;
  readonly owner_user_id: string;
  readonly worker_id: string;
  readonly position: number;
  readonly agent_cli: string;
  readonly root_id: string;
  readonly kind: string;
  readonly name: string;
  readonly digest: string;
  readonly source_key: string;
  readonly value: string;
  readonly label: string;
  readonly action: string;
  readonly status: string;
  readonly target: { readonly [key: string]: JsonValue };
  readonly detail: string;
  readonly error: string | null;
}

export interface NewLibraryItem {
  readonly agentCli: string;
  readonly rootId: string;
  readonly kind: string;
  readonly name: string;
  readonly digest: string;
  readonly sourceKey: string;
  readonly value: string;
  readonly label: string;
  readonly action: string;
}

export const insertLibraryItems = (
  sql: SqlClient.SqlClient,
  run: { id: string; ownerId: string; workerId: string },
  items: readonly NewLibraryItem[],
) =>
  Effect.forEach(
    items.entries(),
    ([position, item]) => sql`
      INSERT INTO import_library_items (id, run_id, owner_user_id, worker_id, position, agent_cli, root_id, kind, name,
                                        digest, source_key, value, label, action, status)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${run.id}::uuid, ${run.ownerId}::uuid, ${run.workerId}::uuid, ${position},
              ${item.agentCli}, ${item.rootId}, ${item.kind}, ${item.name}, ${item.digest}, ${item.sourceKey},
              ${item.value}, ${item.label}, ${item.action}, 'pending')`,
    { discard: true },
  );

export const libraryItems = (sql: SqlClient.SqlClient, runId: string) =>
  sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ${runId}::uuid ORDER BY position`;

export const libraryItemsOf = (sql: SqlClient.SqlClient, runIds: readonly string[]) =>
  sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ANY(${runIds}::uuid[]) ORDER BY run_id, position`;

export const nextLibraryItem = (sql: SqlClient.SqlClient, runId: string) =>
  sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ${runId}::uuid AND status = 'pending'
                   ORDER BY position LIMIT 1`;

/** Items of this owner on a worker that are imported and live (a later import of the same value is "imported"). */
export const liveLibraryItems = (sql: SqlClient.SqlClient, ownerId: string, workerId: string) =>
  sql<LibraryRow>`SELECT * FROM import_library_items
                   WHERE owner_user_id = ${ownerId}::uuid AND worker_id = ${workerId}::uuid AND status = 'done'`;

/**
 * A library item's new state, in an importTransaction that locks its run first (locks.ts): library items belong to
 * their run, and every write to them holds the run's lock.
 */
export const setLibraryStatus = (
  sql: SqlClient.SqlClient,
  row: { readonly id: string; readonly run_id: string },
  status: string,
  change: { target?: { readonly [key: string]: JsonValue }; detail?: string; error?: string | null } = {},
) =>
  importTransaction(
    sql,
    { runs: [row.run_id] },
    () =>
      sql`UPDATE import_library_items
             SET status = ${status}, updated_at = now(),
                 target = coalesce(${change.target === undefined ? null : JSON.stringify(change.target)}::jsonb, target),
                 detail = coalesce(${change.detail ?? null}, detail),
                 error = ${change.error ?? null}
           WHERE id = ${row.id}::uuid RETURNING id`,
  );

/**
 * What an applied or undone item records (its state and what it changed), as the last step of the transaction that
 * made the change: the change and its receipt commit together, so Undo always finds what an import did.
 */
export const libraryReceipt =
  (
    row: { readonly id: string; readonly run_id: string },
    status: string,
    change: { target?: { readonly [key: string]: JsonValue }; detail?: string } = {},
  ) =>
  (sql: SqlClient.SqlClient) =>
    setLibraryStatus(sql, row, status, change).pipe(
      // No item to record it on: the change is rolled back with the rest of the transaction.
      Effect.flatMap((rows) => (rows.length > 0 ? Effect.void : Effect.die(new Error("The import item is gone.")))),
      Effect.orDie,
    );

export function toUiLibrary(row: LibraryRow): ui.ImportLibraryResult {
  return create(ui.ImportLibraryResultSchema, {
    id: row.id,
    agentCli: row.agent_cli,
    kind: row.kind,
    name: row.label || row.name,
    status: row.status,
    error: row.error ?? "",
    detail: row.detail,
  });
}

/** A library item failed, unless its run was stopped meanwhile (its run locked first, locks.ts). */
export const failLibraryItem = (
  sql: SqlClient.SqlClient,
  row: { readonly id: string; readonly run_id: string },
  error: string,
) =>
  importTransaction(sql, { runs: [row.run_id] }, (locks) =>
    Effect.gen(function* () {
      if (locks.runs.get(row.run_id)?.status !== "running") return;
      yield* sql`UPDATE import_library_items SET status = 'failed', error = ${error}, updated_at = now()
                  WHERE id = ${row.id}::uuid AND status = 'pending'`;
    }),
  );
