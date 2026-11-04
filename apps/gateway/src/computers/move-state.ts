import { create, fromBinary, toBinary, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { computerLink as link, ui } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { mapIds, qualify } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

/**
 * Stage 8 of docs/linked-computers.md: the database side of moving a thread (with its side threads)
 * or a bot. The source freezes, exports and commits; the target stages and applies. Every step is
 * one transaction or idempotent, so a restart at any point resumes or rolls back cleanly.
 */
type Sql = SqlClient.SqlClient;

/** Files and blobs of a thread that fit one move message (the link's message limit is 48 MiB). */
const MAX_FILES = 40 * 1024 * 1024;

const ThreadRowSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  parent_thread_id: Schema.NullOr(Schema.String),
  title: Schema.String,
  title_source: Schema.String,
  provider: Schema.String,
  provider_profile_id: Schema.NullOr(Schema.String),
  settings: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    permissionMode: Schema.optionalKey(Schema.String),
    instructions: Schema.optionalKey(Schema.String),
  }),
  cwd: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  project_id: Schema.String,
  remote_parent_ref: Schema.NullOr(Schema.String),
  remote_parent_kind: Schema.NullOr(Schema.String),
  last_seq: Schema.Union([Schema.String, Schema.Number]),
});

export type ThreadRowJson = typeof ThreadRowSchema.Type;

export const threadRowJson = (json: string): ThreadRowJson =>
  Schema.decodeUnknownSync(ThreadRowSchema)(JSON.parse(json));

const JsonRow = Schema.Record(Schema.String, Schema.MutableJson);

const BotRowsSchema = Schema.Struct({
  bot: Schema.StructWithRest(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      provider_instance: Schema.String,
      last_read_seq: Schema.Union([Schema.Number, Schema.String]),
      configuration: Schema.StructWithRest(Schema.Struct({ name: Schema.optionalKey(Schema.String) }), [JsonRow]),
    }),
    [JsonRow],
  ),
  turns: Schema.Array(JsonRow),
  messages: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ id: Schema.String, seq: Schema.Union([Schema.Number, Schema.String]) }), [
      JsonRow,
    ]),
  ),
  tool_calls: Schema.Array(JsonRow),
  approvals: Schema.Array(JsonRow),
  handoff_notes: Schema.Array(JsonRow),
  routines: Schema.Array(JsonRow),
  wakeups: Schema.Array(JsonRow),
  grants: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ connector_type: Schema.String, name: Schema.String }), [JsonRow]),
  ),
  mcp: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [JsonRow])),
});

export type BotRows = typeof BotRowsSchema.Type;

export const botRowsJson = (json: string): BotRows => Schema.decodeUnknownSync(BotRowsSchema)(JSON.parse(json));

export type Frozen = { schedules?: { id: string; status: string; next_run_at: string | null }[]; family?: string[] };

export function transaction<A, E>(store: ComputerStore, body: (sql: Sql) => Effect.Effect<A, E>): Promise<A> {
  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(body(sql));
    }),
  );
}

// ------------------------------------------------------------------ what blocks a move

/** Why a thread cannot move now; empty when it can. `family`: the main thread and its side threads. */
export function threadBlocker(sql: Sql, owner: string, family: string[]) {
  return Effect.gen(function* () {
    const busy = yield* sql.unsafe<{ reason: string }>(
      `SELECT CASE
      WHEN EXISTS (SELECT 1 FROM turns WHERE thread_id = ANY($1::uuid[]) AND status IN ('queued','running')) THEN 'A turn is running or queued. Wait for it to finish or stop it, then move.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND status = 'running') THEN 'A turn is running. Wait for it to finish or stop it, then move.'
      WHEN EXISTS (SELECT 1 FROM interaction_requests WHERE thread_id = ANY($1::uuid[]) AND status = 'pending') THEN 'A question or approval is waiting for an answer.'
      WHEN EXISTS (SELECT 1 FROM turn_steers WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','accepted')) THEN 'A message is still being delivered to the running turn.'
      WHEN EXISTS (SELECT 1 FROM thread_items WHERE thread_id = ANY($1::uuid[]) AND type = 'background_task' AND status = 'in_progress') THEN 'A background task is still running.'
      WHEN EXISTS (SELECT 1 FROM agent_bus_calls WHERE (source_thread_id = ANY($1::uuid[]) OR target_thread_id = ANY($1::uuid[]))
        AND (status = 'requested' OR notify_status IN ('pending','steering'))) THEN 'Work with other agents is still in progress.'
      WHEN EXISTS (SELECT 1 FROM computer_agent_calls WHERE owner_user_id = $2::uuid AND direction = 'incoming' AND target_id = ANY($1::uuid[])
        AND notify AND NOT detached AND report_status = 'pending' AND target_turn_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM turns u WHERE u.id = target_turn_id AND u.status IN ('queued','running'))) THEN 'Another computer waits for a report from this thread.'
      WHEN EXISTS (SELECT 1 FROM bot_thread_watches w JOIN turns u ON u.id = w.target_turn_id WHERE w.target_thread_id = ANY($1::uuid[]) AND NOT w.delivered
        AND u.status IN ('queued','running')) THEN 'A bot is waiting for this thread to finish.'
      ELSE '' END AS reason`,
      [family, owner],
    );

    return busy[0]?.reason ?? "";
  });
}

/** The main thread a move takes, with its side threads; or why it cannot be moved at all. */
export function threadFamily(sql: Sql, owner: string, threadId: string, lock = false) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      id: string;
      kind: string;
      parent_thread_id: string | null;
      title: string;
      runtime: string;
      moved_to: string | null;
      deleted_at: Date | null;
      archived_at: Date | null;
      project_id: string;
    }>(
      `SELECT id, kind, parent_thread_id, title, runtime, moved_to, deleted_at, archived_at, project_id FROM threads
        WHERE owner_user_id = $2::uuid AND (id = $1::uuid OR (parent_thread_id = $1::uuid AND deleted_at IS NULL)) ORDER BY (id = $1::uuid) DESC, created_at, id${lock ? " FOR UPDATE" : ""}`,
      [threadId, owner],
    );

    const main = rows[0];

    if (!main || main.id !== threadId || main.deleted_at)
      return { error: "Thread not found", main: undefined, family: [] };

    if (main.kind !== "main") return { error: "Move its main thread; side threads move with it.", main, family: [] };

    if (main.moved_to) return { error: "This thread is already moving.", main, family: [] };

    if (rows.some((r) => r.runtime !== "worker"))
      return { error: "Threads without a worker can't move yet.", main, family: [] };

    return { error: "", main, family: rows.map((r) => r.id) };
  });
}

/** Why a bot cannot move now; empty when it can. */
export function botBlocker(sql: Sql, owner: string, botId: string) {
  return Effect.gen(function* () {
    const bot = (yield* sql.unsafe<{ moved_to: string | null }>(
      `SELECT moved_to FROM bots WHERE id = $1::uuid AND owner_user_id = $2::uuid AND deleted_at IS NULL`,
      [botId, owner],
    ))[0];

    if (!bot) return "Bot not found";

    if (bot.moved_to) return "This bot is already moving.";

    const busy = yield* sql.unsafe<{ reason: string }>(
      `SELECT CASE
      WHEN EXISTS (SELECT 1 FROM bot_turns WHERE bot_id = $1::uuid AND status IN ('queued','running','waiting')) THEN 'The bot is working. Wait for it to finish or stop it, then move.'
      WHEN EXISTS (SELECT 1 FROM bot_approvals WHERE bot_id = $1::uuid AND status = 'pending') THEN 'A card waits for your answer.'
      WHEN EXISTS (SELECT 1 FROM bot_thread_watches WHERE bot_id = $1::uuid AND NOT delivered) THEN 'The bot is waiting for a thread to finish.'
      ELSE '' END AS reason`,
      [botId],
    );

    return busy[0]?.reason ?? "";
  });
}

// ------------------------------------------------------------------ source: freeze, export, commit, roll back

/** Freezes a thread family for a move and records it, in one transaction. Returns an error text or the frozen state. */
export function freezeThread(
  store: ComputerStore,
  input: { moveId: string; threadId: string; target: string; batchId?: string; placement: JsonValue },
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;
      const { error, main, family } = yield* threadFamily(sql, owner, input.threadId, true);

      if (error || !main) return { error };
      const blocked = yield* threadBlocker(sql, owner, family);

      if (blocked) return { error: blocked };

      // A schedule cannot fire while the thread moves: paused here, its next run restored by a rollback
      // and carried to the new home by the export.
      const schedules = yield* sql.unsafe<{ id: string; status: string; next_run_at: string | null }>(
        `SELECT id, status, next_run_at FROM schedules
      WHERE thread_id = ANY($1::uuid[]) AND status IN ('active','paused') ORDER BY id FOR UPDATE`,
        [family],
      );

      yield* sql.unsafe(
        `UPDATE schedules SET status = 'paused', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = ANY($1::uuid[])`,
        [schedules.map((s) => s.id)],
      );
      yield* sql.unsafe(`UPDATE threads SET moved_to = $2 WHERE id = ANY($1::uuid[])`, [family, input.target]);
      const frozen: Frozen = { schedules: [...schedules], family };
      yield* sql.unsafe(
        `INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,batch_id,title,state,placement,frozen)
      VALUES ($1::uuid,$2::uuid,'source',$3,'thread',$4::uuid,$5::uuid,$6,'preparing',$7::jsonb,$8::jsonb)`,
        [
          owner,
          input.moveId,
          input.target,
          input.threadId,
          input.batchId ?? null,
          main.title,
          JSON.stringify(input.placement),
          JSON.stringify(frozen),
        ],
      );

      return { error: "", title: main.title, family };
    }),
  );
}

export function freezeBot(
  store: ComputerStore,
  input: { moveId: string; botId: string; target: string; batchId?: string },
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const rows = yield* sql.unsafe<{ id: string; name: string }>(
        `SELECT id, configuration ->> 'name' AS name FROM bots WHERE id = $1::uuid AND owner_user_id = $2::uuid AND deleted_at IS NULL FOR UPDATE`,
        [input.botId, owner],
      );

      if (!rows[0]) return { error: "Bot not found" };
      const blocked = yield* botBlocker(sql, owner, input.botId);

      if (blocked) return { error: blocked };
      yield* sql.unsafe(`UPDATE bots SET moved_to = $2 WHERE id = $1::uuid`, [input.botId, input.target]);
      yield* sql.unsafe(
        `INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,batch_id,title,state)
      VALUES ($1::uuid,$2::uuid,'source',$3,'bot',$4::uuid,$5::uuid,$6,'preparing')`,
        [owner, input.moveId, input.target, input.botId, input.batchId ?? null, rows[0].name ?? "Bot"],
      );

      return { error: "", title: rows[0].name ?? "Bot" };
    }),
  );
}

/** The full state of a frozen thread family: history, rows, schedules, files and transcript blobs. Never secrets. */
export async function exportThread(
  store: ComputerStore,
  history: (threadId: string) => Promise<ui.ThreadSnapshot>,
  family: string[],
  frozen: Frozen,
  sourceName: string,
) {
  const owner = store.owner;
  const threads: link.MovedThread[] = [];

  for (const id of family) {
    const row = (
      await store.query<{ row: ThreadRowJson }>(
        `SELECT json_build_object('id',id,'kind',kind,'parent_thread_id',parent_thread_id,'title',title,'title_source',title_source,
      'provider',provider,'provider_profile_id',provider_profile_id,'settings',settings,'cwd',cwd,'created_at',created_at,'archived_at',archived_at,'runtime',runtime,
      'project_id',project_id,'remote_parent_ref',remote_parent_ref,'remote_parent_kind',remote_parent_kind,'last_seq',last_seq) AS row
      FROM threads WHERE id = $1::uuid AND owner_user_id = $2::uuid`,
        [id, owner],
      )
    )[0]?.row;

    if (!row) throw new Error("thread disappeared during its move");
    const snapshot = await history(id);
    // Secrets stay on this computer; schedules travel as rows; nothing waits for an answer here.
    snapshot.secrets = [];
    snapshot.schedules = [];
    snapshot.interactions = [];

    const schedules = await store.query<{ row: JsonObject & { id: string } }>(
      `SELECT row_to_json(s) AS row FROM schedules s WHERE thread_id = $1::uuid AND status IN ('active','paused')`,
      [id],
    );

    const schedulesJson = schedules.map(({ row }) => {
      const before = frozen.schedules?.find((s) => s.id === row.id);

      return JSON.stringify(before ? { ...row, status: before.status, next_run_at: before.next_run_at } : row);
    });

    threads.push(create(link.MovedThreadSchema, { history: snapshot, rowJson: JSON.stringify(row), schedulesJson }));
  }

  const files = await store.query<{
    row: JsonObject;
    data: Uint8Array | null;
    mime_type: string;
    thumbnail: Uint8Array | null;
    thumbnail_mime_type: string | null;
  }>(
    `SELECT row_to_json(a) AS row, b.data, b.mime_type, t.data AS thumbnail, t.mime_type AS thumbnail_mime_type FROM attachments a
      JOIN blobs b ON b.sha256 = a.sha256 LEFT JOIN blobs t ON t.sha256 = a.thumb_sha256
     WHERE a.owner_user_id = $2::uuid AND a.thread_id = ANY($1::uuid[]) AND b.data IS NOT NULL`,
    [family, owner],
  );

  const blobs = await store.query<{ sha256: string; mime_type: string; data: Uint8Array }>(
    `SELECT DISTINCT b.sha256, b.mime_type, b.data FROM thread_blobs tb
    JOIN blobs b ON b.sha256 = tb.sha256 WHERE tb.thread_id = ANY($1::uuid[]) AND b.data IS NOT NULL`,
    [family],
  );

  const size =
    files.reduce((n, f) => n + (f.data?.length ?? 0) + (f.thumbnail?.length ?? 0), 0) +
    blobs.reduce((n, b) => n + b.data.length, 0);

  if (size > MAX_FILES) throw new MoveRefused("The thread's files are too large to move (over 40 MiB).");

  return create(link.ThreadMoveSchema, {
    threads,
    sourceName,
    files: files.map((f) => ({
      attachmentJson: JSON.stringify(f.row),
      data: f.data ?? new Uint8Array(),
      mimeType: f.mime_type,
      ...(f.thumbnail && { thumbnail: f.thumbnail, thumbnailMimeType: f.thumbnail_mime_type ?? "" }),
    })),
    blobs: blobs.map((b) => ({ sha256: b.sha256, mimeType: b.mime_type, data: b.data })),
  });
}

/** The rows of a frozen bot. Connector grants and MCP servers stay here; their names tell the user what to connect again. */
export async function exportBot(store: ComputerStore, botId: string, sourceName: string) {
  const rows = (
    await store.query<{ rows: BotRows }>(
      `SELECT json_build_object(
      'bot', (SELECT row_to_json(b) FROM bots b WHERE b.id = $1::uuid AND b.owner_user_id = $2::uuid),
      'turns', coalesce((SELECT json_agg(t ORDER BY t.created_at, t.id) FROM bot_turns t WHERE t.bot_id = $1::uuid), '[]'),
      'messages', coalesce((SELECT json_agg(m ORDER BY m.seq) FROM bot_messages m WHERE m.bot_id = $1::uuid), '[]'),
      'tool_calls', coalesce((SELECT json_agg(c) FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE t.bot_id = $1::uuid), '[]'),
      'approvals', coalesce((SELECT json_agg(a) FROM bot_approvals a WHERE a.bot_id = $1::uuid), '[]'),
      'handoff_notes', coalesce((SELECT json_agg(n) FROM bot_handoff_notes n WHERE n.bot_id = $1::uuid), '[]'),
      'routines', coalesce((SELECT json_agg(r) FROM bot_routines r WHERE r.bot_id = $1::uuid), '[]'),
      'wakeups', coalesce((SELECT json_agg(w) FROM bot_wakeups w WHERE w.bot_id = $1::uuid), '[]'),
      'grants', coalesce((SELECT json_agg(json_build_object('connector_type', a.connector_type, 'name', a.name)) FROM connector_accounts a
        WHERE a.owner_user_id = $2::uuid AND (a.all_bots OR EXISTS (SELECT 1 FROM connector_bot_grants g WHERE g.account_id = a.id AND g.bot_id = $1::uuid))), '[]'),
      'mcp', coalesce((SELECT json_agg(json_build_object('name', s.name)) FROM bot_mcp_connections c JOIN bot_mcp_servers s ON s.id = c.server_id WHERE c.bot_id = $1::uuid), '[]')
    ) AS rows`,
      [botId, store.owner],
    )
  )[0]?.rows;

  if (!rows?.bot) throw new Error("bot disappeared during its move");

  return create(link.BotMoveSchema, { rowsJson: JSON.stringify(rows), sourceName });
}

/** The cut-over on the source: its copy becomes a redirect to the target, in one transaction with the decision. */
export function commitSource(
  store: ComputerStore,
  move: MoveRow,
  home: { nodeId: string; name: string },
  self: string,
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const locked = (yield* sql.unsafe<MoveRow>(
        `SELECT * FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [owner, move.id],
      ))[0];

      if (!locked || locked.state !== "preparing") return locked?.state ?? "missing";
      const ids = move.kind === "thread" ? (move.frozen.family ?? [move.item_id]) : [move.item_id];

      if (move.kind === "thread") {
        yield* sql.unsafe(
          `UPDATE threads SET deleted_at = coalesce(deleted_at, now()), deletion_batch_id = $2::uuid, title_requested = false, title_revision = title_revision + 1
        WHERE id = ANY($1::uuid[])`,
          [ids, move.item_id],
        );
        yield* sql.unsafe(
          `UPDATE schedules SET status = 'cancelled', next_run_at = NULL, updated_at = now() WHERE thread_id = ANY($1::uuid[]) AND status IN ('active','paused')`,
          [ids],
        );
      } else
        yield* sql.unsafe(
          `UPDATE bots SET deleted_at = coalesce(deleted_at, now()), updated_at = now() WHERE id = $1::uuid`,
          [move.item_id],
        );
      // Cross-computer agent relations end with the move, as with an unlink; messages follow the redirect.
      yield* sql.unsafe(
        `UPDATE computer_agent_calls SET detached = true WHERE owner_user_id = $1::uuid AND (actor_id = ANY($2::uuid[]) OR target_id = ANY($2::uuid[]))`,
        [owner, ids],
      );

      for (const id of ids)
        yield* redirect(sql, owner, {
          itemId: id,
          kind: move.kind,
          homeNodeId: home.nodeId,
          homeName: home.name,
          fromNodeId: self,
        });
      yield* sql.unsafe(
        `UPDATE computer_moves SET state = 'committed', updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, move.id],
      );
      yield* audit(sql, owner, `computer.move.${move.kind}.sent`, move.item_id, { move_id: move.id, to: home.nodeId });

      return "committed";
    }),
  );
}

/** A rollback before the cut-over: the thing runs here again. The target is told when it can be reached. */
export function unfreezeSource(
  store: ComputerStore,
  moveId: string,
  error: string,
  state: "aborting" | "aborted" = "aborting",
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const move = (yield* sql.unsafe<MoveRow>(
        `SELECT * FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid AND role = 'source' FOR UPDATE`,
        [owner, moveId],
      ))[0];

      if (!move || move.state !== "preparing") return move?.state ?? "missing";

      if (move.kind === "thread") {
        const family = move.frozen.family ?? [move.item_id];
        yield* sql.unsafe(`UPDATE threads SET moved_to = NULL WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [
          family,
        ]);

        for (const s of move.frozen.schedules ?? [])
          yield* sql.unsafe(
            `UPDATE schedules SET status = $2, next_run_at = $3, updated_at = now() WHERE id = $1::uuid AND status = 'paused'`,
            [s.id, s.status, s.status === "active" ? s.next_run_at : null],
          );
      } else
        yield* sql.unsafe(`UPDATE bots SET moved_to = NULL WHERE id = $1::uuid AND deleted_at IS NULL`, [move.item_id]);
      yield* sql.unsafe(
        `UPDATE computer_moves SET state = $3, error = $4, updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, moveId, state, error.slice(0, 500)],
      );

      return state;
    }),
  );
}

/**
 * Unlinking during a cut-over the target never confirmed: the thing stays here. Its copy is restored and
 * the redirect removed; the unlinked computer may keep its own copy, but the two no longer share anything.
 */
export function restoreSource(store: ComputerStore, move: MoveRow) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;
      const ids = move.kind === "thread" ? (move.frozen.family ?? [move.item_id]) : [move.item_id];

      if (move.kind === "thread") {
        yield* sql.unsafe(
          `UPDATE threads SET moved_to = NULL, deleted_at = NULL, deletion_batch_id = NULL WHERE id = ANY($1::uuid[])`,
          [ids],
        );

        for (const s of move.frozen.schedules ?? [])
          yield* sql.unsafe(
            `UPDATE schedules SET status = $2, next_run_at = $3, updated_at = now() WHERE id = $1::uuid AND status = 'cancelled'`,
            [s.id, s.status, s.status === "active" ? s.next_run_at : null],
          );
      } else
        yield* sql.unsafe(`UPDATE bots SET moved_to = NULL, deleted_at = NULL WHERE id = $1::uuid`, [move.item_id]);
      yield* sql.unsafe(`DELETE FROM computer_redirects WHERE owner_user_id = $1::uuid AND item_id = ANY($2::uuid[])`, [
        owner,
        ids,
      ]);
      yield* sql.unsafe(
        `UPDATE computer_moves SET state = 'aborted', error = 'The other computer was unlinked before it confirmed the move.', updated_at = now()
      WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, move.id],
      );
      yield* audit(sql, owner, `computer.move.${move.kind}.restored`, move.item_id, { move_id: move.id });
    }),
  );
}

// ------------------------------------------------------------------ target: stage, apply, discard

export type MoveRow = {
  id: string;
  role: "source" | "target";
  peer_node_id: string;
  kind: "thread" | "bot";
  item_id: string;
  batch_id: string | null;
  title: string;
  state: string;
  placement: { workspaceId?: string; projectId?: string };
  payload: Uint8Array | null;
  redo: string[];
  frozen: Frozen;
  error: string;
  created_at: Date;
  updated_at: Date;
};

export class MoveRefused extends Error {}

/** Stages a move on the target. A repeated prepare of the same move is answered from its record. */
export function stage(
  store: ComputerStore,
  peer: string,
  prepare: link.MovePrepare,
  placement: { workspaceId?: string; projectId?: string },
  redo: string[],
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const known = (yield* sql.unsafe<MoveRow>(
        `SELECT * FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, prepare.moveId],
      ))[0];

      if (known) return known.peer_node_id === peer && known.role === "target" ? known.state : "conflict";

      const ids =
        prepare.kind === "thread"
          ? (prepare.thread?.threads ?? []).map((t) => threadRowJson(t.rowJson).id)
          : [prepare.itemId];

      const table = prepare.kind === "bot" ? "bots" : "threads";

      if ((yield* sql.unsafe(`SELECT 1 FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).length) return "exists";
      yield* sql.unsafe(
        `INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,batch_id,title,state,placement,payload,redo)
      VALUES ($1::uuid,$2::uuid,'target',$3,$4,$5::uuid,$6::uuid,$7,'prepared',$8::jsonb,$9,$10::jsonb)`,
        [
          owner,
          prepare.moveId,
          peer,
          prepare.kind,
          prepare.itemId,
          prepare.batchId || null,
          prepare.title.slice(0, 200),
          JSON.stringify(placement),
          toBinary(link.MovePrepareSchema, prepare),
          JSON.stringify(redo),
        ],
      );

      return "prepared";
    }),
  );
}

export async function moveRow(store: ComputerStore, id: string) {
  return (
    await store.query<MoveRow>(`SELECT * FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid`, [
      store.owner,
      id,
    ])
  )[0];
}

export const payloadOf = (move: MoveRow) => fromBinary(link.MovePrepareSchema, move.payload!);

/** Records the decision on the target. Applying follows (and is retried) separately. */
export async function decideTarget(store: ComputerStore, peer: string, moveId: string, decision: string) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const move = (yield* sql.unsafe<MoveRow>(
        `SELECT * FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid AND role = 'target' FOR UPDATE`,
        [owner, moveId],
      ))[0];

      if (!move || move.peer_node_id !== peer) return decision === "abort" ? "aborted" : "missing";

      if (move.state !== "prepared") return move.state;

      if (decision === "commit") {
        yield* sql.unsafe(
          `UPDATE computer_moves SET state = 'committed', updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
          [owner, moveId],
        );

        return "committed";
      }

      yield* discard(sql, owner, move);

      return "aborted";
    }),
  );
}

function discard(sql: Sql, owner: string, move: MoveRow) {
  return Effect.gen(function* () {
    yield* sql.unsafe(
      `UPDATE computer_moves SET state = 'aborted', payload = NULL, updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
      [owner, move.id],
    );
  });
}

export const discardTarget = (store: ComputerStore, move: MoveRow) =>
  transaction(store, (sql) => discard(sql, store.owner, move));

/** Applies a staged bot in one transaction: it becomes this computer's, with its conversation, routines and reminders. */
export function applyBot(store: ComputerStore, move: MoveRow, self: { nodeId: string; name: string }) {
  const prepare = payloadOf(move);
  const rows = botRowsJson(prepare.bot!.rowsJson);

  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const locked = (yield* sql.unsafe<MoveRow>(
        `SELECT state FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [owner, move.id],
      ))[0];

      if (locked?.state !== "committed") return;

      const local = (table: string, id: JsonValue | undefined) =>
        id
          ? sql
              .unsafe(`SELECT 1 FROM ${table} WHERE id = $1::uuid AND owner_user_id = $2::uuid`, [id, owner])
              .pipe(Effect.map((r) => r.length > 0))
          : Effect.succeed(false);

      const creator = (yield* local("bots", rows.bot["created_by_bot_id"])) ? rows.bot["created_by_bot_id"] : null;

      const reconnect = [
        ...rows.grants.map((g) => `${g.name} (${g.connector_type})`),
        ...rows.mcp.map((m) => `MCP server ${m.name}`),
      ];

      yield* insertRows(sql, "bots", [
        {
          ...rows.bot,
          owner_user_id: owner,
          moved_to: null,
          deleted_at: null,
          created_by_bot_id: creator,
          move_notes: {
            from_node_id: move.peer_node_id,
            from_name: prepare.bot!.sourceName,
            reconnect,
            moved_at: new Date().toISOString(),
          },
        },
      ]);
      yield* insertRows(sql, "bot_routines", rows.routines);

      const bots = new Set(
        (yield* sql.unsafe<{ id: string }>(`SELECT id FROM bots WHERE owner_user_id = $1::uuid`, [owner])).map(
          (b) => b.id,
        ),
      );

      yield* insertRows(
        sql,
        "bot_turns",
        rows.turns.map((t) => ({
          ...t,
          lease_token: null,
          lease_until: null,
          reply_to_bot_id: bots.has(String(t["reply_to_bot_id"])) ? t["reply_to_bot_id"] : null,
        })),
      );
      // New sequence numbers here, in the same order; the read marker follows its message.
      yield* insertRows(sql, "bot_messages", rows.messages, { omit: ["seq"], order: "seq" });
      const lastRead = Number(rows.bot.last_read_seq);
      const read = rows.messages.filter((m) => Number(m.seq) <= lastRead).map((m) => m.id);
      yield* sql.unsafe(
        `UPDATE bots SET last_read_seq = coalesce((SELECT max(seq) FROM bot_messages WHERE id = ANY($2::uuid[])), 0) WHERE id = $1::uuid`,
        [move.item_id, read],
      );
      yield* insertRows(sql, "bot_tool_calls", rows.tool_calls);
      yield* insertRows(sql, "bot_approvals", rows.approvals);
      yield* insertRows(sql, "bot_handoff_notes", rows.handoff_notes);
      yield* insertRows(sql, "bot_wakeups", rows.wakeups);
      yield* redirect(sql, owner, {
        itemId: move.item_id,
        kind: "bot",
        homeNodeId: self.nodeId,
        homeName: self.name,
        fromNodeId: move.peer_node_id,
      });
      yield* sql.unsafe(
        `UPDATE computer_moves SET state = 'done', payload = NULL, error = '', updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, move.id],
      );
      yield* audit(sql, owner, "computer.move.bot.received", move.item_id, {
        move_id: move.id,
        from: move.peer_node_id,
      });
    }),
  );
}

/**
 * The history of a moved thread as this computer shows it. Ids of the old home's other things carry its
 * suffix (they stay there, or follow a redirect); the moved threads, their turns and files are plain here.
 */
export function localHistory(history: ui.ThreadSnapshot, from: string, moved: ReadonlySet<string>) {
  const snapshot = create(ui.ThreadSnapshotSchema, history);
  const own = new Set(moved);

  for (const turn of snapshot.turns) own.add(turn.id);

  for (const steer of snapshot.steers) own.add(steer.id);
  qualify(ui.ThreadSnapshotSchema, snapshot, from);
  mapIds(ui.ThreadSnapshotSchema, snapshot, (value) => {
    const { id, node } = splitId(value);

    return node === nodeRef(from) && own.has(id) ? id : value;
  });

  return snapshot;
}

/** Everything of a staged thread except the thread rows (created through the core). One transaction, idempotent. */
export function applyThreadRows(
  store: ComputerStore,
  move: MoveRow,
  thread: link.MovedThread,
  input: {
    threadId: string;
    projectId: string;
    ordinalTurn: string;
    history: ui.ThreadSnapshot;
    handoff: string;
    notice: { eventId: string; payload: JsonValue };
    files: link.MovedFile[];
    blobs: link.MovedBlob[];
  },
) {
  const row = threadRowJson(thread.rowJson);

  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const known = yield* sql.unsafe(`SELECT 1 FROM computer_moved_threads WHERE thread_id = $1::uuid`, [
        input.threadId,
      ]);

      if (known.length) return;
      const history = input.history;
      const ordinal = history.turns.reduce((n, t) => Math.max(n, t.ordinal), 0);

      // A cancelled placeholder holds the history's turn numbers; it is never shown or run.
      if (ordinal > 0)
        yield* sql.unsafe(
          `INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, completed_at) VALUES ($1::uuid, $2::uuid, $3, 'cancelled', 'provider', '{}'::jsonb, now())`,
          [input.ordinalTurn, input.threadId, ordinal],
        );
      const lastSeq = BigInt(history.lastSeq) + 1n;
      yield* sql.unsafe(
        `INSERT INTO thread_events (thread_id, seq, event_id, origin, kind, payload, occurred_at) VALUES ($1::uuid, $2, $3::uuid, 'gateway', 'notice', $4::jsonb, now())`,
        [input.threadId, String(lastSeq), input.notice.eventId, JSON.stringify(input.notice.payload)],
      );
      yield* sql.unsafe(
        `UPDATE threads SET last_seq = greatest(last_seq, $2), created_at = $3, title = $4, title_source = $5, settings = settings || $6::jsonb, archived_at = $7,
      status = CASE WHEN $7::timestamptz IS NULL THEN status ELSE 'archived' END, archived_by = CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE 'user' END
      WHERE id = $1::uuid`,
        [
          input.threadId,
          String(lastSeq),
          row.created_at,
          row.title,
          row.title_source === "provisional" ? "user" : row.title_source,
          JSON.stringify({ handoff: input.handoff }),
          row.kind === "main" ? row.archived_at : null,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO thread_reads (user_id, thread_id, seen_seq) VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = greatest(thread_reads.seen_seq, EXCLUDED.seen_seq)`,
        [owner, input.threadId, String(lastSeq)],
      );
      yield* sql.unsafe(
        `INSERT INTO computer_moved_threads (thread_id, from_node_id, history, ordinal_turn_id) VALUES ($1::uuid, $2, $3, $4::uuid)`,
        [input.threadId, move.peer_node_id, toBinary(ui.ThreadSnapshotSchema, history), input.ordinalTurn],
      );

      for (const json of thread.schedulesJson) {
        const s = Schema.decodeUnknownSync(JsonRow)(JSON.parse(json));
        yield* insertRows(sql, "schedules", [
          {
            ...s,
            thread_id: input.threadId,
            project_id: input.projectId,
            created_by_user_id: owner,
            created_by_call_id: null,
            hops: 0,
            last_turn_id: null,
            lease_owner: null,
            lease_until: null,
            placement_cursor: null,
            last_edited_by_user_id: owner,
            last_edited_at: new Date().toISOString(),
          },
        ]);
      }

      for (const file of input.files) {
        const a = Schema.decodeUnknownSync(JsonRow)(JSON.parse(file.attachmentJson));

        if (a["thread_id"] !== input.threadId) continue;
        yield* sql.unsafe(
          `INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
          [a["sha256"], file.data.length, file.mimeType, file.data],
        );

        if (a["thumb_sha256"] && file.thumbnail.length)
          yield* sql.unsafe(
            `INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
            [a["thumb_sha256"], file.thumbnail.length, file.thumbnailMimeType, file.thumbnail],
          );
        // A file belongs to a turn of its thread: here, the placeholder of the moved history.
        yield* insertRows(sql, "attachments", [
          {
            ...a,
            owner_user_id: owner,
            turn_id: a["turn_id"] && ordinal > 0 ? input.ordinalTurn : null,
            thread_id: a["turn_id"] && ordinal > 0 ? input.threadId : null,
            thumb_sha256: file.thumbnail.length ? a["thumb_sha256"] : null,
          },
        ]);
      }

      for (const blob of input.blobs) {
        yield* sql.unsafe(
          `INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
          [blob.sha256, blob.data.length, blob.mimeType, blob.data],
        );
        yield* sql.unsafe(`INSERT INTO thread_blobs (thread_id, sha256) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`, [
          input.threadId,
          blob.sha256,
        ]);
      }
    }),
  );
}

/** The last step of applying a thread move: the redirects and the record, in one transaction. */
export function finishThread(
  store: ComputerStore,
  move: MoveRow,
  ids: string[],
  self: { nodeId: string; name: string },
) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      for (const id of ids)
        yield* redirect(sql, owner, {
          itemId: id,
          kind: "thread",
          homeNodeId: self.nodeId,
          homeName: self.name,
          fromNodeId: move.peer_node_id,
        });
      yield* sql.unsafe(
        `UPDATE computer_moves SET state = 'done', payload = NULL, error = '', updated_at = now() WHERE owner_user_id = $1::uuid AND id = $2::uuid AND state = 'committed'`,
        [owner, move.id],
      );
      yield* audit(sql, owner, "computer.move.thread.received", move.item_id, {
        move_id: move.id,
        from: move.peer_node_id,
      });
    }),
  );
}

// ------------------------------------------------------------------ helpers

function redirect(
  sql: Sql,
  owner: string,
  item: { itemId: string; kind: string; homeNodeId: string; homeName: string; fromNodeId: string },
) {
  return sql.unsafe(
    `INSERT INTO computer_redirects (owner_user_id, item_id, kind, home_node_id, home_name, from_node_id, moved_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now())
    ON CONFLICT (owner_user_id, item_id) DO UPDATE SET kind = EXCLUDED.kind, home_node_id = EXCLUDED.home_node_id, home_name = EXCLUDED.home_name,
    from_node_id = EXCLUDED.from_node_id, moved_at = EXCLUDED.moved_at`,
    [owner, item.itemId, item.kind, item.homeNodeId, item.homeName, item.fromNodeId],
  );
}

/** Both sides of a move write an audit entry: what moved, which move and the other computer. */
function audit(sql: Sql, owner: string, action: string, target: string, details: Record<string, string>) {
  return sql.unsafe(
    `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb)`,
    [Bun.randomUUIDv7(), owner, action, action.split(".")[2] ?? "thread", target, JSON.stringify(details)],
  );
}

/** Rows from another computer of the same schema: only the columns both have, defaults for the rest. */
function insertRows(
  sql: Sql,
  table: string,
  rows: readonly { [column: string]: JsonValue | undefined }[],
  options: { omit?: string[]; order?: string } = {},
) {
  return Effect.gen(function* () {
    if (!rows.length) return;

    const columns = (yield* sql.unsafe<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    ))
      .map((c) => c.column_name)
      .filter((c) => !options.omit?.includes(c) && rows.some((r) => c in r));

    const list = columns.map((c) => `"${c}"`).join(", ");
    yield* sql.unsafe(
      `INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(null::${table}, $1::json) AS r${options.order ? ` ORDER BY r."${options.order}"` : ""}
      ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows)],
    );
  });
}

export const redirectItem = (itemId: string, kind: string, home: { nodeId: string; name: string }, from: string) =>
  create(link.MovedItemSchema, {
    itemId,
    kind,
    homeNodeId: home.nodeId,
    homeName: home.name,
    fromNodeId: from,
    movedAtMs: BigInt(Date.now()),
  });

export const qualifiedNew = (id: string, home: string, self: string) => (home === self ? id : qualifyId(id, home));
