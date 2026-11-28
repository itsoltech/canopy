import { toBinary, type JsonValue } from "@bufbuild/protobuf";

import { computerLink as link } from "@canopy/contracts";

import { Effect, Predicate } from "effect";

import { botRowsJson, insertRows, MOVE_COLUMNS, threadRowJson, type MoveRow, type Sql } from "./move-payload.ts";

import { audit, redirect, transaction } from "./move-state.ts";
import type { ComputerStore } from "./store.ts";
import { movedAttachment, movedBotRecords, movedSchedule, movedVisual } from "./move-validation.ts";
import { importBotComposer } from "./move-bot-composer.ts";

/** A collision is a preparation refusal, before the source makes its irreversible decision. */
function conflicts(sql: Sql, prepare: link.MovePrepare) {
  return Effect.gen(function* () {
    const keys: [string, string, string[]][] = [];

    if (prepare.thread) {
      const parts = prepare.thread.threads;
      const visuals = parts.flatMap((part) => part.visualsJson.map(movedVisual));
      keys.push(["thread_visuals", "visual_id", visuals.map((v) => v.visual_id)]);
      keys.push(["thread_visuals", "call_id", visuals.map((v) => v.call_id)]);
      keys.push(["schedules", "id", parts.flatMap((part) => part.schedulesJson.map((json) => movedSchedule(json).id))]);
    }

    if (prepare.bot) {
      const rows = botRowsJson(prepare.bot.rowsJson);

      for (const [table, records] of [
        ["bot_routines", rows.routines],
        ["bot_turns", rows.turns],
        ["bot_messages", rows.messages],
        ["bot_tool_calls", rows.tool_calls],
        ["bot_approvals", rows.approvals],
        ["bot_wakeups", rows.wakeups],
      ] as const)
        keys.push([table, "id", records.map((row) => String(row["id"]))]);
    }

    const files = prepare.thread?.files ?? prepare.bot?.files ?? [];
    keys.push(["attachments", "id", files.map((f) => movedAttachment(f).id)]);

    for (const [table, column, ids] of keys) {
      if (
        ids.length &&
        (yield* sql.unsafe(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1::uuid[]) LIMIT 1`, [ids])).length
      )
        return true;
    }

    return false;
  });
}

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
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`move:${owner}:${prepare.moveId}`},0))`;

      const known = (yield* sql.unsafe<MoveRow>(
        `SELECT ${MOVE_COLUMNS} FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
        [owner, prepare.moveId],
      ))[0];

      if (known) {
        if (
          known.peer_node_id !== peer ||
          known.role !== "target" ||
          known.kind !== prepare.kind ||
          known.item_id !== prepare.itemId
        )
          return "conflict";

        return known.state === "aborted" ? "refused" : "prepared";
      }

      const ids =
        prepare.kind === "thread"
          ? (prepare.thread?.threads ?? []).map((t) => threadRowJson(t.rowJson).id)
          : [prepare.itemId];

      const table = prepare.kind === "bot" ? "bots" : "threads";

      if ((yield* sql.unsafe(`SELECT 1 FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).length) return "exists";

      if (yield* conflicts(sql, prepare)) return "conflict";
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
    await store.query<MoveRow>(
      `SELECT ${MOVE_COLUMNS} FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
      [store.owner, id],
    )
  )[0];
}

/** Records the decision on the target. Applying follows (and is retried) separately. */
export async function decideTarget(store: ComputerStore, peer: string, moveId: string, decision: string) {
  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const move = (yield* sql.unsafe<MoveRow>(
        `SELECT ${MOVE_COLUMNS} FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid AND role = 'target' FOR UPDATE`,
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

/** Continuations point at their parked cards once both arrived; a card outside this bot is never linked. */
function restoreContinuations(sql: Sql, botId: string, turns: readonly Record<string, JsonValue>[]) {
  const links = turns.flatMap((turn) =>
    Predicate.isString(turn["id"]) && Predicate.isString(turn["resume_approval_id"])
      ? [{ turn: turn["id"], approval: turn["resume_approval_id"] }]
      : [],
  );

  if (!links.length) return Effect.void;

  return sql.unsafe(
    `UPDATE bot_turns t SET resume_approval_id = r.approval FROM unnest($2::uuid[], $3::uuid[]) r(turn, approval)
      WHERE t.id = r.turn AND t.bot_id = $1::uuid
        AND EXISTS (SELECT 1 FROM bot_approvals a WHERE a.id = r.approval AND a.bot_id = $1::uuid)`,
    [botId, links.map((l) => l.turn), links.map((l) => l.approval)],
  );
}

/** Applies a staged bot in one transaction: it becomes this computer's, with its conversation, routines and reminders. */
export async function applyBot(
  store: ComputerStore,
  move: MoveRow,
  self: { nodeId: string; name: string },
  bot: link.BotMove,
) {
  const rows = movedBotRecords(bot, botRowsJson(bot.rowsJson), move.peer_node_id);

  return transaction(store, (sql) =>
    Effect.gen(function* () {
      const owner = store.owner;

      const locked = (yield* sql.unsafe<MoveRow>(
        `SELECT state FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [owner, move.id],
      ))[0];

      if (locked?.state !== "committed") return;

      const reconnect = [
        ...rows.grants.map((g) => `${g.name} (${g.connector_type})`),
        ...rows.mcp.map((m) => `MCP server ${m.name}`),
      ];

      yield* insertRows(
        sql,
        "bots",
        [
          {
            ...rows.bot,
            client_request_id: `move:${move.id}`,
            owner_user_id: owner,
            moved_to: null,
            deleted_at: null,
            move_notes: {
              from_node_id: move.peer_node_id,
              from_name: bot.sourceName,
              reconnect,
              moved_at: new Date().toISOString(),
            },
          },
        ],
        { strict: true },
      );

      const ownRows = (records: readonly Record<string, JsonValue>[]) =>
        records.map((record) => ({ ...record, bot_id: move.item_id }));

      yield* insertRows(sql, "bot_routines", ownRows(rows.routines), { strict: true });
      // Event triggers name resources of the source computer: they arrive off, until the owner points them here.
      yield* sql.unsafe(
        `UPDATE bot_routines SET enabled = false, revision = revision + 1 WHERE bot_id = $1::uuid AND kind = 'trigger'`,
        [move.item_id],
      );

      // A continuation names its parked card, which arrives with the approvals below.
      yield* insertRows(sql, "bot_turns", ownRows(rows.turns), { omit: ["resume_approval_id"], strict: true });
      // New sequence numbers here, in the same order; the read marker follows its message.
      yield* importBotComposer(sql, owner, move.item_id, bot);
      yield* insertRows(sql, "bot_messages", rows.messages, { omit: ["seq"], order: "seq", strict: true });
      const lastRead = Number(rows.bot.last_read_seq);
      const read = rows.messages.filter((m) => Number(m.seq) <= lastRead).map((m) => m.id);
      yield* sql.unsafe(
        `UPDATE bots SET last_read_seq = coalesce((SELECT max(seq) FROM bot_messages WHERE bot_id=$1::uuid AND id = ANY($2::uuid[])), 0) WHERE id = $1::uuid`,
        [move.item_id, read],
      );
      yield* insertRows(sql, "bot_tool_calls", rows.tool_calls, { strict: true });
      yield* insertRows(sql, "bot_approvals", ownRows(rows.approvals), { strict: true });
      yield* restoreContinuations(sql, move.item_id, rows.turns);
      yield* insertRows(sql, "bot_handoff_notes", ownRows(rows.handoff_notes), { strict: true });
      yield* insertRows(sql, "bot_wakeups", ownRows(rows.wakeups), { strict: true });
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
