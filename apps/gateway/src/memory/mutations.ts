import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/errors.ts";
import {
  checkedDraft,
  checkedRevision,
  MemoryConflict,
  noteFromRow,
  scopeKey,
  uuid,
  type MemoryDraft,
  type MemoryScope,
  type NoteRow,
  type SaveOptions,
} from "./model.ts";

const missing = () => new NotFound("Memory note not found.");
const changed = () => new MemoryConflict("This note changed. Reload it before editing.");

function scopeExists(sql: SqlClient.SqlClient, owner: string, scope: MemoryScope) {
  switch (scope.kind) {
    case "project":
      return sql`SELECT 1 FROM projects WHERE id=${scope.projectId}::uuid AND owner_user_id=${owner}::uuid AND kind<>'scratch'`;
    case "worker":
      return sql`SELECT 1 FROM projects p JOIN project_workspaces pw ON pw.project_id=p.id JOIN workers w ON w.id=pw.worker_id
        WHERE p.id=${scope.projectId}::uuid AND p.owner_user_id=${owner}::uuid AND p.kind<>'scratch'
          AND w.id=${scope.workerId}::uuid AND (w.owner_user_id IS NULL OR w.owner_user_id=${owner}::uuid)`;
    case "bot":
      return sql`SELECT 1 FROM bots WHERE id=${scope.botId}::uuid AND owner_user_id=${owner}::uuid`;
    case "conversation":
      return sql`SELECT 1 FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
        JOIN bots b ON b.id=r.bot_id WHERE c.id=${scope.conversationId}::uuid AND b.id=${scope.botId}::uuid
          AND b.owner_user_id=${owner}::uuid AND r.owner_user_id=${owner}::uuid`;
  }
}

function createNote(
  sql: SqlClient.SqlClient,
  owner: string,
  scope: MemoryScope,
  draft: MemoryDraft,
  options: SaveOptions,
) {
  return Effect.gen(function* () {
    if (!(yield* scopeExists(sql, owner, scope)).length)
      return yield* Effect.fail(new NotFound("Memory scope not found."));
    yield* sql`INSERT INTO agent_memory_scopes(owner_user_id,project_id,worker_id,bot_id,conversation_id)
      VALUES (${owner}::uuid,${"projectId" in scope ? scope.projectId : null}::uuid,${"workerId" in scope ? scope.workerId : null}::uuid,
        ${"botId" in scope ? scope.botId : null}::uuid,${"conversationId" in scope ? scope.conversationId : null}::uuid)
      ON CONFLICT (owner_user_id,scope_key) DO NOTHING`;

    const [row] =
      yield* sql<NoteRow>`INSERT INTO agent_memory_notes(id,owner_user_id,scope_key,title,body,aliases,pinned,source_kind,source_id,source_turn_id)
      VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${scopeKey(scope)},${draft.title},${draft.body},
        ${draft.aliases ?? []}::text[],${draft.pinned ?? false},
        ${options.source?.kind ?? null},${options.source?.id ?? null}::uuid,${options.source?.turnId ?? null}::uuid) RETURNING *`;

    // SAFETY: The single-row mutation returns its inserted or locked target.
    return row!;
  });
}

function existing(sql: SqlClient.SqlClient, owner: string, id: string, revision: number, key?: string) {
  return Effect.gen(function* () {
    const [row] =
      yield* sql<NoteRow>`SELECT * FROM agent_memory_notes WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid FOR UPDATE`;

    if (!row || (key !== undefined && row.scope_key !== key)) return yield* Effect.fail(missing());

    if (row.revision !== revision) return yield* Effect.fail(changed());

    return row;
  });
}

function updateNote(
  sql: SqlClient.SqlClient,
  owner: string,
  id: string,
  draft: MemoryDraft,
  options: SaveOptions,
  key?: string,
) {
  return Effect.gen(function* () {
    const old = yield* existing(sql, owner, uuid(id), checkedRevision(options.expectedRevision), key);

    const [row] = yield* sql<NoteRow>`UPDATE agent_memory_notes SET title=${draft.title},body=${draft.body},
      aliases=${draft.aliases ?? old.aliases}::text[],
      pinned=${draft.pinned ?? old.pinned}, revision=revision+1, updated_at=clock_timestamp(),
      source_kind=${options.source?.kind ?? old.source_kind},source_id=${options.source?.id ?? old.source_id}::uuid,
      source_turn_id=${options.source?.turnId ?? old.source_turn_id}::uuid WHERE id=${old.id}::uuid AND owner_user_id=${owner}::uuid RETURNING *`;

    // SAFETY: The single-row mutation returns its inserted or locked target.
    return row!;
  });
}

function replay(sql: SqlClient.SqlClient, owner: string, operation: string, hash: string, key: string) {
  return Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`canopy.memory:${owner}:${operation}`},0))`;

    const [receipt] = yield* sql<{ request_hash: string; note_id: string; note_revision: number }>`
      SELECT request_hash,note_id,note_revision FROM agent_memory_operations WHERE owner_user_id=${owner}::uuid AND operation_id=${operation}`;

    if (!receipt) return undefined;

    if (receipt.request_hash !== hash)
      return yield* Effect.fail(
        new MemoryConflict("This operation ID was already used for a different memory request."),
      );

    return yield* existing(sql, owner, receipt.note_id, receipt.note_revision, key);
  });
}

function advance(sql: SqlClient.SqlClient, owner: string, key: string) {
  return sql`UPDATE agent_memory_scopes SET revision=nextval('agent_memory_revision') WHERE owner_user_id=${owner}::uuid AND scope_key=${key}`;
}

export function saveNote(
  sql: SqlClient.SqlClient,
  owner: string,
  scope: MemoryScope,
  input: MemoryDraft,
  options: SaveOptions,
) {
  const draft = checkedDraft(input);
  const key = scopeKey(scope);
  const { operationId, source } = options;

  if (options.id !== undefined) {
    uuid(options.id);
    checkedRevision(options.expectedRevision);
  } else if (options.expectedRevision !== undefined) throw new Invalid("Provide the ID of the note to update.");

  if (
    operationId !== undefined &&
    (!operationId.trim() || operationId.includes("\0") || operationId.length > 512 || !source)
  )
    throw new Invalid("A memory operation needs a valid ID and a source turn.");

  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        key,
        options.id ?? null,
        options.expectedRevision ?? null,
        input.title,
        input.body,
        input.aliases ?? null,
        input.pinned ?? null,
        source && [source.kind, uuid(source.id), uuid(source.turnId)],
      ]),
    )
    .digest("hex");

  return sql.withTransaction(
    Effect.gen(function* () {
      if (operationId) {
        const previous = yield* replay(sql, owner, operationId, hash, key);

        if (previous) return noteFromRow(previous);
      }

      const row = options.id
        ? yield* updateNote(sql, owner, options.id, draft, options, key)
        : yield* createNote(sql, owner, scope, draft, options);

      yield* advance(sql, owner, row.scope_key);

      if (operationId)
        yield* sql`INSERT INTO agent_memory_operations(owner_user_id,operation_id,request_hash,note_id,note_revision)
      VALUES (${owner}::uuid,${operationId},${hash},${row.id}::uuid,${row.revision})`;

      return noteFromRow(row);
    }),
  );
}

export function editNote(
  sql: SqlClient.SqlClient,
  owner: string,
  id: string,
  draft: MemoryDraft,
  expectedRevision: number,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* updateNote(sql, owner, id, draft, { expectedRevision });
      yield* advance(sql, owner, row.scope_key);

      return noteFromRow(row);
    }),
  );
}

export function removeNote(sql: SqlClient.SqlClient, owner: string, id: string, revision: number) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const old = yield* existing(sql, owner, uuid(id), checkedRevision(revision));
      yield* sql`DELETE FROM agent_memory_notes WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`;
      yield* advance(sql, owner, old.scope_key);
    }),
  );
}
