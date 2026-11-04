import { toBinary, type JsonValue } from "@bufbuild/protobuf";

import { computerLink as link } from "@canopy/contracts";

import { Effect } from "effect";

import { botRowsJson, insertRows, payloadOf, threadRowJson, type MoveRow, type Sql } from "./move-payload.ts";

import { audit, redirect, transaction } from "./move-state.ts";
import type { ComputerStore } from "./store.ts";

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

export function discard(sql: Sql, owner: string, move: MoveRow) {
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
