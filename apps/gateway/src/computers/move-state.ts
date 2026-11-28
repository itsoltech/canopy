import { create, isMessage, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { computerLink as link, MentionKind, MentionSchema, ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { insertRows, MoveRefused, threadRowJson, type MoveRow, type Sql } from "./move-payload.ts";
import {
  insertMovedBlob,
  insertMovedFileBytes,
  movedAttachment,
  movedSchedule,
  movedVisual,
} from "./move-validation.ts";
import { mapIds, qualify } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

export {
  botRowsJson,
  MOVE_COLUMNS,
  MoveRefused,
  payloadOf,
  qualifiedNew,
  threadRowJson,
  type BotRows,
  type Frozen,
  type MoveRow,
  type ThreadRowJson,
} from "./move-payload.ts";

export {
  botBlocker,
  commitSource,
  exportBot,
  exportThread,
  freezeBot,
  freezeThread,
  restoreSource,
  threadBlocker,
  threadFamily,
  unfreezeSource,
} from "./move-source.ts";

export { applyBot, decideTarget, discard, discardTarget, moveRow, stage } from "./move-target.ts";

export function transaction<A, E>(store: ComputerStore, body: (sql: Sql) => Effect.Effect<A, E>): Promise<A> {
  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(body(sql));
    }),
  );
}

/**
 * The history of a moved thread as this computer shows it. Ids of the old home's other things carry its
 * suffix (they stay there, or follow a redirect); the moved threads, their turns and files are plain here.
 */
export function localHistory(
  history: ui.ThreadSnapshot,
  from: string,
  contents: {
    threads: ReadonlySet<string>;
    files: ReadonlySet<string>;
    visuals: ReadonlySet<string>;
  },
) {
  const snapshot = create(ui.ThreadSnapshotSchema, history);
  const turns = new Set(snapshot.turns.map((t) => t.id));
  const steers = new Set(snapshot.steers.map((s) => s.id));
  const items = new Set(snapshot.items.map((i) => i.item?.itemId));
  qualify(ui.ThreadSnapshotSchema, snapshot, from);
  mapIds(ui.ThreadSnapshotSchema, snapshot, (value, field, desc, message) => {
    const { id, node } = splitId(value);

    if (node !== nodeRef(from)) return value;

    if (
      contents.threads.has(id) &&
      (field === "thread_id" ||
        field.endsWith("_thread_id") ||
        (field === "id" && desc === ui.ThreadSchema) ||
        (field === "mention_id" && isMessage(message, MentionSchema) && message.kind === MentionKind.THREAD))
    )
      return id;

    if (
      turns.has(id) &&
      (field === "turn_id" ||
        field.endsWith("_turn_id") ||
        field === "input_id" ||
        (field === "id" && desc === ui.TurnSchema))
    )
      return id;

    if (steers.has(id) && (field === "steer_id" || field === "input_id" || (field === "id" && desc === ui.SteerSchema)))
      return id;

    if (items.has(id) && (field === "item_id" || field.endsWith("_item_id"))) return id;

    if (contents.visuals.has(id) && field === "visual_id") return id;

    if (
      contents.files.has(id) &&
      (field === "attachment_id" ||
        field === "attachment_ids" ||
        (field === "id" && desc === ui.AttachmentSchema) ||
        (field === "mention_id" && isMessage(message, MentionSchema) && message.kind === MentionKind.ATTACHMENT))
    )
      return id;

    return value;
  });

  return snapshot;
}

/** Published visual versions of a moved thread, owned here and attached to its placeholder turn. */
function insertMovedVisuals(
  sql: SqlClient.SqlClient,
  rows: readonly string[],
  threadId: string,
  owner: string,
  turnId: string,
) {
  return Effect.gen(function* () {
    if (!rows.length) return;
    const versions = rows.map(movedVisual);
    const ids = [...new Set(versions.map((v) => v.visual_id))].sort();
    // A visual ID names the whole version history, even when two concurrent moves carry different versions.
    yield* sql.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended(id, 0)) FROM unnest($1::text[]) v(id) ORDER BY id",
      [ids],
    );

    if ((yield* sql.unsafe("SELECT 1 FROM thread_visuals WHERE visual_id=ANY($1::uuid[]) LIMIT 1", [ids])).length)
      return yield* Effect.fail(new MoveRefused("A visual in the move already exists on this computer."));

    for (const visual of versions)
      yield* sql.unsafe(
        `INSERT INTO thread_visuals (visual_id, version, thread_id, owner_user_id, turn_id, call_id, item_id, title, description,
        height, schema_version, kit_version, spec, sha256, created_at, html_document)
      SELECT visual_id, version, $2::uuid, $3::uuid, $4::uuid, call_id, item_id, title, description, height, schema_version,
        kit_version, spec, sha256, created_at, coalesce(html_document, false)
      FROM json_populate_record(NULL::thread_visuals, $1::json)`,
        [JSON.stringify(visual), threadId, owner, turnId],
      );
  });
}

function importThreadFiles(
  sql: Sql,
  owner: string,
  thread: string,
  files: readonly link.MovedFile[],
  turn: string | null,
  replay: boolean,
) {
  return Effect.gen(function* () {
    for (const file of files) {
      const row = movedAttachment(file);

      if (row["thread_id"] !== thread) continue;
      yield* insertMovedFileBytes(sql, file, row);
      const thumbnail = file.thumbnail.length ? (row.thumb_sha256 ?? null) : null;

      if (replay) {
        yield* sql`UPDATE attachments SET thumb_sha256=${thumbnail} WHERE id=${row.id}::uuid
          AND owner_user_id=${owner}::uuid AND thread_id=${thread}::uuid AND sha256=${row.sha256}
          AND thumb_sha256 IS DISTINCT FROM ${thumbnail}`;
        continue;
      }

      const bound = row["turn_id"] ? turn : null;
      yield* insertRows(
        sql,
        "attachments",
        [
          {
            ...row,
            owner_user_id: owner,
            bot_id: null,
            bot_turn_id: null,
            slack_file_id: null,
            turn_id: bound,
            thread_id: bound ? thread : null,
            thumb_sha256: thumbnail,
          },
        ],
        { strict: true },
      );
    }
  });
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
    /** The thread continues its own harness session (docs/thread-transfers.md) instead of a handoff note. */
    native?: { sessionId: string; note: string };
    files: link.MovedFile[];
    blobs: link.MovedBlob[];
  },
) {
  const row = threadRowJson(thread.rowJson);

  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      // Admit before any blob lock: replay cannot allocate bytes after retention fenced this thread.
      const admitted = yield* sql`SELECT t.id FROM threads t WHERE t.id=${input.threadId}::uuid
        AND t.owner_user_id=${owner}::uuid AND t.purged_at IS NULL AND (
          t.creation_request_id=${`move:${move.id}:${input.threadId}`} OR
          (t.creation_request_id IS NULL AND EXISTS (SELECT 1 FROM computer_moved_threads h
            WHERE h.thread_id=t.id AND h.from_node_id=${move.peer_node_id}))) FOR UPDATE`;

      if (!admitted.length) return yield* Effect.fail(new MoveRefused("The thread has been permanently deleted."));

      const known = (yield* sql<{
        from_node_id: string;
      }>`SELECT from_node_id FROM computer_moved_threads WHERE thread_id=${input.threadId}::uuid`)[0];

      if (known && known.from_node_id !== move.peer_node_id)
        return yield* Effect.fail(new MoveRefused("The thread belongs to a different move."));

      for (const blob of input.blobs) {
        yield* insertMovedBlob(sql, blob.sha256, blob.data, blob.mimeType);
        yield* sql`INSERT INTO thread_blobs(thread_id,sha256,verified) VALUES(${input.threadId}::uuid,${blob.sha256},true)
          ON CONFLICT (thread_id,sha256) DO UPDATE SET verified=true WHERE NOT thread_blobs.verified`;
      }

      if (known) return yield* importThreadFiles(sql, owner, input.threadId, input.files, null, true);
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
        `UPDATE threads SET last_seq = greatest(last_seq, $2), created_at = $3, title = $4, title_source = $5, settings = settings || $6::jsonb, archived_at = $7, auto_archive_on_merge = $8,
      permission_mode_selected = permission_mode_selected OR $9,
      snoozed = $10, snoozed_until = $11,
      status = CASE WHEN $7::timestamptz IS NULL THEN status ELSE 'archived' END, archived_by = CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE 'user' END
      WHERE id = $1::uuid`,
        [
          input.threadId,
          String(lastSeq),
          row.created_at,
          row.title,
          row.title_source === "provisional" ? "user" : row.title_source,
          JSON.stringify(input.native ? { branchNote: input.native.note } : { handoff: input.handoff }),
          // The main thread is archived after its side threads exist (movesApplyThread).
          null,
          row.auto_archive_on_merge ?? null,
          history.thread?.permissionModeSelected ?? false,
          row.snoozed ?? false,
          row.snoozed ? (row.snoozed_until ?? null) : null,
        ],
      );

      if (input.native)
        yield* sql.unsafe(
          `UPDATE threads SET provider_thread_id = $2, status = CASE WHEN status = 'creating' THEN 'idle' ELSE status END
          WHERE id = $1::uuid AND (provider_thread_id IS NULL OR provider_thread_id = $2)`,
          [input.threadId, input.native.sessionId],
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
        const s = movedSchedule(json);
        yield* insertRows(
          sql,
          "schedules",
          [
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
          ],
          { strict: true },
        );
      }

      // Visual versions belong to the moved history's placeholder turn, like its files.
      if (ordinal > 0) yield* insertMovedVisuals(sql, thread.visualsJson, input.threadId, owner, input.ordinalTurn);

      yield* importThreadFiles(sql, owner, input.threadId, input.files, ordinal > 0 ? input.ordinalTurn : null, false);
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

export function redirect(
  sql: Sql,
  owner: string,
  item: { itemId: string; kind: string; homeNodeId: string; homeName: string; fromNodeId: string },
) {
  return sql.unsafe(
    `INSERT INTO computer_redirects (owner_user_id, item_id, kind, home_node_id, home_name, from_node_id, moved_at,basis)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,now(),'local_move')
    ON CONFLICT (owner_user_id,kind,item_id,from_node_id) DO UPDATE SET home_node_id=EXCLUDED.home_node_id,
    home_name=EXCLUDED.home_name,moved_at=EXCLUDED.moved_at,basis='local_move'`,
    [owner, item.itemId, item.kind, item.homeNodeId, item.homeName, item.fromNodeId],
  );
}

/** Both sides of a move write an audit entry: what moved, which move and the other computer. */
export function audit(sql: Sql, owner: string, action: string, target: string, details: Record<string, string>) {
  return sql.unsafe(
    `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb)`,
    [Bun.randomUUIDv7(), owner, action, action.split(".")[2] ?? "thread", target, JSON.stringify(details)],
  );
}

const ARCHIVE_REASONS = ["user", "agent", "merge"] as const;

/**
 * The family's archive state as it was on the source, once every row exists: side threads first, each its own time
 * and reason. A side thread closed with its main thread keeps that link, so reopening the main thread reopens it.
 */
export async function restoreArchived(
  store: ComputerStore,
  rows: readonly {
    id: string;
    parent_thread_id?: string | null;
    archived_at?: string | Date | null;
    archived_by?: string | null | undefined;
    archived_by_thread_id?: string | null | undefined;
  }[],
) {
  const archived = rows
    .flatMap((r) => {
      if (!r.archived_at) return [];

      const cascade =
        r.archived_by === "cascade" && Boolean(r.parent_thread_id) && r.archived_by_thread_id === r.parent_thread_id;

      // Only reasons this database knows (a partner's value is not trusted); anything else counts as the owner's.
      const by = cascade ? "cascade" : (ARCHIVE_REASONS.find((reason) => reason === r.archived_by) ?? "user");

      return [{ id: r.id, at: new Date(r.archived_at), by, parent: cascade ? r.parent_thread_id : null }];
    })
    .toReversed();

  if (!archived.length) return;
  await transaction(store, (sql) =>
    Effect.forEach(archived, (row) =>
      sql.unsafe(
        `UPDATE threads SET archived_at = $2::timestamptz, status = 'archived', archived_by = $3,
          archived_by_thread_id = $4::uuid
        WHERE id = $1::uuid AND (archived_at IS DISTINCT FROM $2::timestamptz OR archived_by IS DISTINCT FROM $3)`,
        [row.id, row.at.toISOString(), row.by, row.parent],
      ),
    ),
  );
}
