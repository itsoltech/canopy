import { Effect, Predicate } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core-context.ts";
import { Invalid } from "../store/errors.ts";
import {
  checkedDraft,
  noteFromRow,
  pageLimit,
  scopeKey,
  uuid,
  type MemoryDraft,
  type MemoryScope,
  type NoteRow,
  type SaveOptions,
} from "./model.ts";
import { editNote, removeNote, saveNote } from "./mutations.ts";
import { MemoryIndex, MemoryIndexCache } from "./search.ts";

export { MemoryConflict, type MemoryScope, type MemoryDraft, type MemorySource, type MemoryNote } from "./model.ts";

export type MemoryRunner = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;

interface ListOptions {
  scope?: MemoryScope | MemoryScope["kind"] | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

function decodeCursor(cursor?: string) {
  if (!cursor) return;
  const [time, id, extra] = cursor.split("|");
  const date = new Date(time ?? "");

  if (!id || extra !== undefined || !Number.isFinite(date.getTime()) || time !== date.toISOString())
    throw new Invalid("Invalid memory page cursor.");

  return { date, id: uuid(id) };
}

function scopeVersion(sql: SqlClient.SqlClient, owner: string, keys: string[]) {
  return sql<{ version: string }>`SELECT coalesce(string_agg(revision::text, ',' ORDER BY scope_key), '') AS version
    FROM agent_memory_scopes WHERE owner_user_id=${owner}::uuid AND scope_key IN ${sql.in(keys)}`;
}

function snapshot(sql: SqlClient.SqlClient, owner: string, keys: string[], expected?: string) {
  type Row = ({ id: null } | NoteRow) & { version: string };

  return sql<Row>`SELECT clock.version,n.* FROM (${scopeVersion(sql, owner, keys)}) clock
    LEFT JOIN agent_memory_notes n ON n.owner_user_id=${owner}::uuid AND n.scope_key IN ${sql.in(keys)}
      AND (${expected ?? null}::text IS NULL OR clock.version=${expected ?? null}::text)`.pipe(
    Effect.map((rows) => ({
      // SAFETY: The ungrouped aggregate yields one clock row even with no notes.
      version: rows[0]!.version,
      notes: rows.flatMap((row) => (row.id === null ? [] : [noteFromRow(row)])),
    })),
  );
}

class MemoryStore {
  readonly #indexes = new MemoryIndexCache();

  constructor(readonly runtime: CoreRuntime) {}

  async search(
    owner: string,
    scopes: readonly MemoryScope[],
    queries: readonly string[],
    limit?: number,
    automatic = false,
    run: MemoryRunner = this.runtime.runPromise,
  ) {
    const keys = [...new Set(scopes.map(scopeKey))].sort();
    const count = pageLimit(limit, 5, 20);

    if (!keys.length || !queries.some((query) => query.trim())) return [];
    const cacheKey = JSON.stringify([owner, keys]);
    const [probe] = await run(SqlClient.SqlClient.use((sql) => scopeVersion(sql, owner, keys)));
    // SAFETY: The ungrouped revision aggregate always yields exactly one row.
    const version = probe!.version;

    const cached = await this.#indexes.get(cacheKey, version, async () => {
      const view = await run(SqlClient.SqlClient.use((sql) => snapshot(sql, owner, keys, version)));

      return view.version === version ? view.notes : undefined;
    });

    // If a mutation raced the probe, take a fresh snapshot in this reader's transaction.
    const index =
      cached ?? new MemoryIndex((await run(SqlClient.SqlClient.use((sql) => snapshot(sql, owner, keys)))).notes);

    return index.search(queries, count, automatic);
  }

  async pinned(owner: string, scopes: readonly MemoryScope[], limit?: number) {
    if (!scopes.length) return [];
    const keys = scopes.map(scopeKey);
    const count = pageLimit(limit, 5, 20);

    const rows = await this.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<NoteRow>`
      SELECT * FROM agent_memory_notes WHERE owner_user_id=${owner}::uuid AND pinned AND scope_key IN ${sql.in(keys)}
      ORDER BY updated_at DESC,id DESC LIMIT ${count}`,
      ),
    );

    return rows.map(noteFromRow);
  }

  async list(owner: string, options: ListOptions = {}) {
    const cursor = decodeCursor(options.cursor);
    const limit = pageLimit(options.limit, 30, 100);
    const { scope } = options;

    const rows = await this.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => {
        const filter = Predicate.isString(scope)
          ? sql`AND scope_key LIKE ${`${scope}:%`}`
          : scope
            ? sql`AND scope_key=${scopeKey(scope)}`
            : sql``;

        const page = cursor ? sql`AND (updated_at,id)<(${cursor.date}::timestamptz,${cursor.id}::uuid)` : sql``;

        return sql<NoteRow>`SELECT * FROM agent_memory_notes WHERE owner_user_id=${owner}::uuid ${filter} ${page}
        ORDER BY updated_at DESC,id DESC LIMIT ${limit + 1}`;
      }),
    );

    const notes = rows.slice(0, limit).map(noteFromRow);
    const last = notes.at(-1);

    return { notes, nextCursor: rows.length > limit && last ? `${last.updatedAt.toISOString()}|${last.id}` : "" };
  }

  async save(
    owner: string,
    scope: MemoryScope,
    draft: MemoryDraft,
    options: SaveOptions = {},
    run: MemoryRunner = this.runtime.runPromise,
  ) {
    return run(SqlClient.SqlClient.use((sql) => saveNote(sql, owner, scope, draft, options)));
  }

  async edit(owner: string, id: string, draft: MemoryDraft, expectedRevision: number) {
    const validated = checkedDraft(draft);

    return this.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => editNote(sql, owner, id, validated, expectedRevision)),
    );
  }

  async remove(owner: string, id: string, expectedRevision: number) {
    await this.runtime.runPromise(SqlClient.SqlClient.use((sql) => removeNote(sql, owner, id, expectedRevision)));
  }
}

const stores = new WeakMap<CoreRuntime, MemoryStore>();

export function memoryFor(runtime: CoreRuntime) {
  let store = stores.get(runtime);

  if (!store) {
    store = new MemoryStore(runtime);
    stores.set(runtime, store);
  }

  return store;
}
