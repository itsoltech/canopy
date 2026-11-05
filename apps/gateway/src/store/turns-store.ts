import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, one, type Fx } from "./errors.ts";
import { writeInteractionTimeline } from "./interaction-timeline.ts";
import type { InteractionRow, TurnRow } from "./rows.ts";
import { toInteraction } from "./ui-mappers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TurnStore {
  /**
   * A user's message as the next turn. With attachments: `input` is the prepared input (note + message) and the
   * attachments are bound to the turn in the same transaction (each only once).
   */
  enqueueTurn(input: {
    threadId: string;
    text: string;
    userId: string;
    clientRequestId: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    input?: TurnRow["input"];
    linked?: { callId: string; hops: number };
  }): Fx<TurnRow>;
  /** A user turn with this client request id, if any (SendMessage idempotency across queue and steer). */
  turnByClientRequest(threadId: string, clientRequestId: string): Fx<TurnRow | undefined>;
  /** Records the model, effort and permission mode a turn is started with. */
  setTurnSettings(turnId: string, settings: { model: string; effort: string; permissionMode: string }): Fx<void>;
  /** Oldest queued user turn of an idle, ready thread with no StartTurn in the outbox yet. */
  nextTurn(threadId: string): Fx<TurnRow | undefined>;
  runningTurn(threadId: string): Fx<TurnRow | undefined>;
  turnsOf(threadId: string): Fx<ReadonlyArray<TurnRow>>;
  /** First task in the visible history, including the fork's inherited prefix. */
  titleInput(threadId: string): Fx<TurnRow | undefined>;
  /** A queued or running turn fails here (e.g. it could not start): the error, where it came from, its code. */
  failTurn(turnId: string, error: string, source: "platform" | "harness", code?: string): Fx<void>;
  /**
   * Ends running worker turns that no longer run on their worker (docs/durability.md, 3.4): the given turns,
   * or every running turn of the worker's threads except `keep` (its Hello.running_turns). The turn ends as
   * interrupted by the system with the reason and the thread is idle again; its pending interactions expire and
   * its steers that did not join it are dropped (pump queues them). A late turn_finished from the worker (e.g. the
   * outcome its harness transcript records) still sets the real outcome.
   */
  endLostTurns(
    input: { workerId: string; reason: string } & (
      | { turnIds: readonly string[] }
      | { keep: readonly { threadId: string; turnId: string }[] }
    ),
  ): Fx<{
    turns: { threadId: string; turnId: string }[];
    interactions: ui.Interaction[];
  }>;
}

export function turnStore(sql: SqlClient.SqlClient): TurnStore {
  return {
    enqueueTurn: ({
      threadId,
      text,
      userId,
      clientRequestId,
      model = "",
      effort = "",
      permissionMode = "",
      input,
      linked,
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const attachments = input?.attachments ?? [];

          if (!text.trim() && attachments.length === 0 && !input?.quotes?.length)
            return yield* Effect.fail(new Invalid("message is empty"));
          const id = Bun.randomUUIDv7();

          const rows = yield* sql<TurnRow>`
                  INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input, model, effort, permission_mode, linked_call_id, hops)
                  SELECT ${id}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, ${linked ? "linked_agent" : "user"}, ${linked ? null : userId}::uuid,
                         ${clientRequestId || null}, ${JSON.stringify(input ?? { text })}::jsonb, ${model}, ${effort}, ${permissionMode}, ${linked?.callId ?? null}::uuid, ${linked?.hops ?? 0}
                    FROM turns WHERE thread_id = ${threadId}::uuid
                  ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
                  RETURNING *`;

          if (!rows[0]) {
            return yield* one(
              yield* sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`,
              "turn",
            );
          }

          if (attachments.length > 0) {
            // Each attachment goes with one message: a concurrent send of the same file fails here and rolls back.
            const bound = yield* sql`
                    UPDATE attachments SET thread_id = ${threadId}::uuid, turn_id = ${id}::uuid
                     WHERE id = ANY(${`{${attachments.map((a) => a.id).join(",")}}`}::uuid[]) AND owner_user_id = ${userId}::uuid AND thread_id IS NULL
                    RETURNING id`;

            if (bound.length !== attachments.length)
              return yield* Effect.fail(new Invalid("an attachment was already sent with another message"));
          }

          return rows[0];
        }),
      ),

    turnByClientRequest: (threadId, clientRequestId) =>
      clientRequestId
        ? sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND client_request_id = ${clientRequestId}`.pipe(
            Effect.map((rows) => rows[0]),
          )
        : Effect.succeed(undefined),

    setTurnSettings: (turnId, { model, effort, permissionMode }) =>
      sql`UPDATE turns SET model = ${model}, effort = ${effort}, permission_mode = ${permissionMode} WHERE id = ${turnId}::uuid`.pipe(
        Effect.asVoid,
      ),

    nextTurn: (threadId) =>
      sql<TurnRow>`
              SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
               WHERE u.thread_id = ${threadId}::uuid AND u.status = 'queued' AND t.provider_thread_id IS NOT NULL
                 AND t.status IN ('idle', 'interrupted', 'failed') AND t.deleted_at IS NULL AND t.archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = u.thread_id AND r.status = 'running')
                 AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))
               ORDER BY u.ordinal LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

    runningTurn: (threadId) =>
      sql<TurnRow>`SELECT * FROM turns WHERE thread_id = ${threadId}::uuid AND status = 'running' LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
      ),

    turnsOf: (threadId) => sql<TurnRow>`
            SELECT u.*, s.*, (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id WHERE bc.id = u.bot_call_id) AS bot_id FROM turns u LEFT JOIN turn_sources s ON s.turn_id = u.id
             WHERE u.thread_id = ${threadId}::uuid
               -- The placeholder holding a moved thread's history numbers is no turn of its own.
               AND NOT EXISTS (SELECT 1 FROM computer_moved_threads m WHERE m.ordinal_turn_id = u.id)
             ORDER BY u.ordinal`,

    titleInput: (threadId) =>
      sql<TurnRow>`
            SELECT u.* FROM thread_fork_chain(${threadId}::uuid) c JOIN turns u ON u.thread_id = c.thread_id
             WHERE u.trigger IN ('user', 'goal', 'agent_bus')
               AND COALESCE(u.input->>'message', u.input->>'text', '') <> ''
               AND (c.level = 0 OR (u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)))
             ORDER BY c.level DESC, u.ordinal LIMIT 1`.pipe(Effect.map((rows) => rows[0])),

    failTurn: (turnId, error, source, code) =>
      sql`
              UPDATE turns SET status = 'failed', error = ${error}, error_source = ${source}, error_code = ${code || null}, completed_at = now()
               WHERE id = ${turnId}::uuid AND status IN ('queued', 'running')`.pipe(Effect.asVoid),

    endLostTurns: (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Only ids that can be turns here (a malformed report must not fail the reconcile).
          const keep = "keep" in input ? input.keep.map((t) => t.turnId).filter((id) => UUID.test(id)) : [];
          const only = "turnIds" in input ? [...input.turnIds] : null;

          const turns = yield* sql<{ id: string; thread_id: string }>`
                  UPDATE turns u SET status = 'interrupted', interrupt_source = 'system', interrupt_reason = ${input.reason}, completed_at = now()
                    FROM threads t
                   WHERE t.id = u.thread_id AND t.worker_id = ${input.workerId}::uuid AND t.runtime = 'worker' AND u.status = 'running'
                     AND (${only}::uuid[] IS NULL OR u.id = ANY(${only}::uuid[])) AND NOT (u.id = ANY(${keep}::uuid[]))
                  RETURNING u.id, u.thread_id`;

          if (turns.length === 0) return { turns: [], interactions: [] };
          const ids = turns.map((t) => t.id);
          const threads = [...new Set(turns.map((t) => t.thread_id))];
          yield* sql`
                  UPDATE threads t SET status = 'idle'
                   WHERE t.id = ANY(${threads}::uuid[]) AND t.status IN ('running', 'waiting_input')
                     AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')`;

          const interactions = yield* sql<InteractionRow>`
                  UPDATE interaction_requests SET status = 'expired', answered_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status = 'pending' AND question_call_id IS NULL
                  RETURNING *`;

          for (const row of interactions) yield* writeInteractionTimeline(sql, row);
          yield* sql`
                  UPDATE turn_steers SET status = 'dropped', reason = ${`the turn ended before the message could join it (${input.reason})`}, updated_at = now()
                   WHERE turn_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'accepted')`;

          return {
            turns: turns.map((t) => ({ threadId: t.thread_id, turnId: t.id })),
            interactions: interactions.map(toInteraction),
          };
        }),
      ),
  };
}
