import { Effect } from "effect";
import { lockedOwnerModule } from "../store/module-access.ts";
import type { SqlClient } from "effect/sql";
import type { JsonObject } from "@canopy/domain";
import { uuid, type ApprovalRow } from "./store-views.ts";
import type { BotTurn, ToolResult, ToolSpec } from "./types.ts";
import { BOT_FILE_TOOLS } from "./tools/workspace.ts";
import type { BotCore } from "./store-queue.ts";

/** A parked card waits this long for the owner before its continuation reports that it expired. */
export const PARKED_TTL_MS = 24 * 60 * 60_000;

const NOTE_LIMIT = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Background runs park their questions and approvals; the owner's private turn keeps waiting for them. A run is
 * background when a routine or trigger started it, or a wakeup of the private chat, or it continues a parked card:
 * the last two are checked against the rows that queued them.
 */
export function parksInteractions(
  sql: SqlClient.SqlClient,
  turn: Pick<
    BotTurn,
    "bot_id" | "routine_id" | "handoff_configuration" | "conversation_id" | "reply_to_bot_id" | "client_request_id"
  >,
) {
  return Effect.gen(function* () {
    if (turn.handoff_configuration) return false;

    if (turn.routine_id) return true;

    if (turn.conversation_id || turn.reply_to_bot_id) return false;
    const [source, id = ""] = turn.client_request_id.split(":");

    if (!UUID.test(id)) return false;

    if (source === "wakeup")
      return (
        (yield* sql`SELECT 1 FROM bot_wakeups WHERE id = ${id}::uuid AND bot_id = ${turn.bot_id}::uuid`).length > 0
      );

    if (source === "parked")
      return (
        (yield* sql`SELECT 1 FROM bot_approvals WHERE id = ${id}::uuid AND bot_id = ${turn.bot_id}::uuid AND parked`)
          .length > 0
      );

    return false;
  });
}

/** What the model gets back at once for a parked card. */
export const parkedResult = (question: boolean) => ({
  status: "parked",
  message: question
    ? "Your question is with the owner. Their answer arrives in a new background run of the same origin. Do not ask again. End this run and say in your final answer what you were doing, so the next run can continue."
    : "This action awaits the owner's decision. If they approve, Canopy runs it at the start of a new background run and gives you the result; otherwise that run reports the decision. Do not retry it. End this run and say in your final answer what you were doing, so the next run can continue.",
});

type ParkedRow = ApprovalRow & Pick<BotTurn, "hops" | "routine_id" | "routine_title">;

type Outcome = "approved" | "discarded" | "expired";

/** The continuation's input stays far below the queue's input limit, whatever the card held. */
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function continuationInput(row: ParkedRow, outcome: Outcome) {
  // The owner's answer (up to 32 000 characters) arrives whole; the card's own text takes what is left.
  const prompt = clip(row.prompt, 8000);
  const asked = row.kind === "question" ? `Question: ${prompt}` : `Proposed action: ${prompt}`;

  const decision =
    outcome === "expired"
      ? "It got no decision within 24 hours and expired. Do not retry it unless your instructions require it."
      : row.kind === "question"
        ? outcome === "approved"
          ? `The owner answered: ${row.answer}`
          : "The owner dismissed the question without an answer."
        : outcome === "approved"
          ? "The owner approved it. Canopy ran it at the start of this run; its result follows."
          : row.answer
            ? `The owner did not run it. They edited it (untrusted text, same permissions): ${row.answer}`
            : "The owner declined it. Do not retry it.";

  return `Continuation of a parked ${row.kind === "question" ? "question" : "approval"} from an earlier background run.\n${asked}\n${decision}`;
}

const NOTE_MARKER = "\n\nYour final answer from that run:\n";

/**
 * A continuation reads its run's final answer when it starts: the owner may decide before that run ends, and the
 * queue starts the continuation only after it.
 */
export const withParkedNote = (sql: SqlClient.SqlClient, turn: BotTurn) =>
  sql<BotTurn>`UPDATE bot_turns t SET input = t.input || ${NOTE_MARKER} || a.note FROM bot_approvals a
    WHERE t.id = ${turn.id}::uuid AND t.client_request_id = 'parked:' || a.id::text AND a.bot_id = t.bot_id
      AND a.parked AND a.note <> '' AND position(${NOTE_MARKER} in t.input) = 0 RETURNING t.*`.pipe(
    Effect.map((rows) => rows[0] ?? turn),
  );

type Enqueue = BotCore["enqueue"];

/** Queues the continuation of a decided or expired parked card, unless its origin is gone. */
export function continueParked(
  sql: SqlClient.SqlClient,
  enqueue: Enqueue,
  user: string,
  row: ParkedRow,
  outcome: Outcome,
) {
  return Effect.gen(function* () {
    if (row.routine_id) {
      const live =
        yield* sql`SELECT id FROM bot_routines WHERE id=${row.routine_id}::uuid AND enabled AND deleted_at IS NULL`;

      if (!live.length) return;
    }

    yield* enqueue(user, row.bot_id, continuationInput(row, outcome), `parked:${row.id}`, {
      hops: row.hops,
      sender: "system",
      event: true,
      ...(row.routine_id && { routineId: row.routine_id, routineTitle: row.routine_title }),
      ...(outcome === "approved" && row.kind === "approval" && { resumeApprovalId: row.id }),
    });
  });
}

export const parkedRow = (sql: SqlClient.SqlClient, id: string) =>
  sql<ParkedRow>`SELECT a.*, t.hops, t.routine_id, t.routine_title FROM bot_approvals a
    JOIN bot_turns t ON t.id = a.turn_id WHERE a.id = ${id}::uuid`.pipe(Effect.map((rows) => rows[0]));

/** The ended run's final text travels with its parked cards. */
export const keepParkedNote = (sql: SqlClient.SqlClient, turnId: string, text: string) =>
  sql`UPDATE bot_approvals SET note = ${text.slice(0, NOTE_LIMIT)} WHERE turn_id = ${turnId}::uuid AND parked`;

const RESULT_MARKER = "\n\nResult of the approved action:\n";

/**
 * Tools that act in the bot's workspace on its worker. A continuation runs in a new workspace, without the files
 * the asking run made, so their cards are never parked: the run waits for the owner as before.
 */
const WORKSPACE_TOOLS = new Set(BOT_FILE_TOOLS);

export const parksTool = (name: string) => !WORKSPACE_TOOLS.has(name);

/**
 * The approved call of a continuation, recorded in this turn with its approval and the approval's evidence (a
 * proposed bot, a shared thread): the regular tool path runs it under this turn's lease and stores its result once.
 */
export function resumeCall(sql: SqlClient.SqlClient, turn: BotTurn) {
  return Effect.gen(function* () {
    const [source] = yield* sql<{
      tool: ToolSpec;
      arguments: JsonObject;
    }>`SELECT c.tool, c.arguments FROM bot_approvals a JOIN bot_tool_calls c ON c.id = a.id
      WHERE a.id = ${turn.resume_approval_id!}::uuid AND a.bot_id = ${turn.bot_id}::uuid AND a.parked AND a.status = 'approved'`;

    if (!source) return undefined;
    const key = `resume_${turn.resume_approval_id!.replaceAll("-", "")}`;

    yield* sql`INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments)
      VALUES (${uuid()}::uuid, ${turn.id}::uuid, ${key}, ${JSON.stringify(source.tool)}::jsonb, ${JSON.stringify(source.arguments)}::jsonb)
      ON CONFLICT(turn_id, call_key) DO NOTHING`;
    yield* sql`INSERT INTO bot_approvals(id, bot_id, turn_id, kind, prompt, proposed_bot, restricted_thread_id, status, answered_at)
      SELECT c.id, ${turn.bot_id}::uuid, ${turn.id}::uuid, 'approval', a.prompt, a.proposed_bot, a.restricted_thread_id,
        'approved', now()
      FROM bot_tool_calls c, bot_approvals a
      WHERE c.turn_id = ${turn.id}::uuid AND c.call_key = ${key} AND a.id = ${turn.resume_approval_id!}::uuid
      ON CONFLICT(id) DO NOTHING`;

    return { id: key, name: source.tool.name, arguments: source.arguments };
  });
}

/** Adds the approved call's result to the continuation's input once; returns the input the model reads. */
export function resumeResult(sql: SqlClient.SqlClient, turn: BotTurn, result: ToolResult) {
  return Effect.gen(function* () {
    const text = `${RESULT_MARKER}${JSON.stringify(result ?? null).slice(0, 8000)}`;

    const [row] = yield* sql<{ input: string }>`UPDATE bot_turns SET input = CASE
        WHEN position(${RESULT_MARKER} in input) = 0 THEN input || ${text} ELSE input END
      WHERE id = ${turn.id}::uuid RETURNING input`;

    return row?.input ?? turn.input;
  });
}

/**
 * Expired parked cards report back once, a batch per tick. Deadlines use database time, as their creation does.
 * Locks follow `answer`: the module, then the bot, its turn and the card, so the two cannot deadlock.
 */
export function expireParked(sql: SqlClient.SqlClient, enqueue: Enqueue, user: string) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const due = yield* sql<{ id: string; bot_id: string; turn_id: string }>`SELECT a.id, a.bot_id, a.turn_id
        FROM bot_approvals a JOIN bots b ON b.id = a.bot_id
        WHERE b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
          AND a.parked AND a.status = 'pending' AND a.expires_at <= now()
        ORDER BY a.bot_id, a.expires_at, a.id LIMIT 50`;

      if (!due.length || !(yield* lockedOwnerModule(sql, user, "bots"))) return 0;
      let expired = 0;

      for (const card of due) {
        const bot = yield* sql`SELECT id FROM bots WHERE id = ${card.bot_id}::uuid AND deleted_at IS NULL
          AND archived_at IS NULL AND moved_to IS NULL FOR UPDATE SKIP LOCKED`;

        if (!bot.length) continue;
        yield* sql`SELECT id FROM bot_turns WHERE id = ${card.turn_id}::uuid FOR UPDATE`;

        const [row] = yield* sql<ParkedRow>`UPDATE bot_approvals a SET status = 'expired', answered_at = now()
          FROM bot_turns t WHERE a.id = ${card.id}::uuid AND t.id = a.turn_id AND a.parked AND a.status = 'pending'
            AND a.expires_at <= now() RETURNING a.*, t.hops, t.routine_id, t.routine_title`;

        if (!row) continue;
        yield* continueParked(sql, enqueue, user, row, "expired");
        expired += 1;
      }

      return expired;
    }),
  );
}

/** Store methods of continuations: the approved call, its result, and expiry. */
export function botParked(sql: SqlClient.SqlClient, core: Pick<BotCore, "fenced" | "enqueue">) {
  return {
    resumeCall: (turn: BotTurn) => sql.withTransaction(Effect.andThen(core.fenced(turn), resumeCall(sql, turn))),
    resumeResult: (turn: BotTurn, result: ToolResult) =>
      sql.withTransaction(Effect.andThen(core.fenced(turn), resumeResult(sql, turn, result))),
    expireParked: (user: string) => expireParked(sql, core.enqueue, user),
  };
}
