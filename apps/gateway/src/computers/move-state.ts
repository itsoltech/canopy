import { create, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { insertRows, JsonRow, threadRowJson, type MoveRow, type Sql } from "./move-payload.ts";
import { mapIds, qualify } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

export {
  botRowsJson,
  MoveRefused,
  payloadOf,
  qualifiedNew,
  redirectItem,
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

export function redirect(
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
export function audit(sql: Sql, owner: string, action: string, target: string, details: Record<string, string>) {
  return sql.unsafe(
    `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb)`,
    [Bun.randomUUIDv7(), owner, action, action.split(".")[2] ?? "thread", target, JSON.stringify(details)],
  );
}
