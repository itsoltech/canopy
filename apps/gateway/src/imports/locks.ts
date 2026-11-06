import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/**
 * Row locks of the CLI import (docs/import.md, "Blokady"). Every import transaction goes through importTransaction:
 * it names the rows it starts from, the helper widens that to every row the transaction may change and locks them
 * all before the body writes anything, in one order for every transaction — runs, then items, then threads, each
 * table in one statement in id order. The body changes only locked rows and rows that belong to a locked thread
 * (turns, events, thread_imports). No two import transactions can then wait for each other.
 *
 * `FOR UPDATE` and `withTransaction` appear nowhere else in apps/gateway/src/imports (locks.test.ts).
 */

export interface LockSeeds {
  readonly runs?: readonly string[];
  /** Items by id; their runs are locked too. */
  readonly items?: readonly string[];
  readonly threads?: readonly string[];
}

export interface LockedRun {
  readonly id: string;
  readonly status: string;
  readonly owner_user_id: string;
}

export interface LockedItem {
  readonly id: string;
  readonly run_id: string;
  readonly status: string;
  readonly thread_id: string | null;
}

export interface Locks {
  readonly runs: ReadonlyMap<string, LockedRun>;
  /** The seeds' items, every item of the seed runs and every item of the locked threads (superseded ones too). */
  readonly items: ReadonlyMap<string, LockedItem>;
  /** The seed threads and the threads of the locked items. */
  readonly threads: ReadonlySet<string>;
}

/** Rows were added to the scope between reading it and locking it (an append created meanwhile): try again. */
class ScopeChanged extends Error {}

interface Scope {
  readonly runs: readonly string[];
  readonly items: readonly string[];
  readonly threads: readonly string[];
}

const sorted = (ids: Iterable<string | null>) => [...new Set([...ids].filter((id) => id !== null))].sort();

/** Every row the seeds reach: runs of seed items, items of runs and threads, threads of those items. */
const scopeOf = (sql: SqlClient.SqlClient, seeds: LockSeeds) =>
  Effect.gen(function* () {
    const seedItems = [...(seeds.items ?? [])];
    const seedRuns = [...(seeds.runs ?? [])];

    const first = yield* sql<{ id: string; run_id: string; thread_id: string | null }>`
      SELECT id, run_id, thread_id FROM import_items
       WHERE id = ANY(${seedItems}::uuid[]) OR run_id = ANY(${seedRuns}::uuid[])
          OR thread_id = ANY(${[...(seeds.threads ?? [])]}::uuid[])`;

    const threads = sorted([...(seeds.threads ?? []), ...first.map((i) => i.thread_id)]);

    const second = yield* sql<{ id: string }>`SELECT id FROM import_items WHERE thread_id = ANY(${threads}::uuid[])`;

    return {
      runs: sorted([...seedRuns, ...first.filter((i) => seedItems.includes(i.id)).map((i) => i.run_id)]),
      items: sorted([...first, ...second].map((i) => i.id)),
      threads,
    } satisfies Scope;
  });

const lockScope = (sql: SqlClient.SqlClient, scope: Scope) =>
  Effect.gen(function* () {
    const runs = yield* sql<LockedRun>`
      SELECT id::text, status, owner_user_id::text FROM import_runs WHERE id = ANY(${scope.runs}::uuid[])
       ORDER BY id FOR UPDATE`;

    const items = yield* sql<LockedItem>`
      SELECT id::text, run_id::text, status, thread_id::text FROM import_items WHERE id = ANY(${scope.items}::uuid[])
       ORDER BY id FOR UPDATE`;

    const threads = yield* sql<{ id: string }>`
      SELECT id::text FROM threads WHERE id = ANY(${scope.threads}::uuid[]) ORDER BY id FOR UPDATE`;

    return {
      runs: new Map(runs.map((r) => [r.id, r])),
      items: new Map(items.map((i) => [i.id, i])),
      threads: new Set(threads.map((t) => t.id)),
    } satisfies Locks;
  });

const covers = (locks: Locks, scope: Scope) =>
  scope.runs.every((id) => locks.runs.has(id)) &&
  scope.items.every((id) => locks.items.has(id)) &&
  scope.threads.every((id) => locks.threads.has(id));

/**
 * `body` in one transaction, after every row the seeds reach is locked (see above). The scope is read again under
 * the locks; when it grew meanwhile the transaction starts over.
 */
export const importTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  seeds: LockSeeds,
  body: (locks: Locks) => Effect.Effect<A, E, R>,
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const locks = yield* lockScope(sql, yield* scopeOf(sql, seeds));

        if (!covers(locks, yield* scopeOf(sql, seeds))) return yield* Effect.fail(new ScopeChanged());

        return yield* body(locks);
      }),
    )
    .pipe(Effect.retry({ while: (e) => e instanceof ScopeChanged, times: 5 }));
