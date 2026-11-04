import { create, type JsonObject, type JsonValue } from "@bufbuild/protobuf";

import { computerLink as link, ui } from "@canopy/contracts";

import { Effect } from "effect";

import {
  MAX_FILES,
  MoveRefused,
  type BotRows,
  type Frozen,
  type MoveRow,
  type Sql,
  type ThreadRowJson,
} from "./move-payload.ts";

import { audit, redirect, transaction } from "./move-state.ts";
import type { ComputerStore } from "./store.ts";

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
