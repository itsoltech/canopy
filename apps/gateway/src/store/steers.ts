import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { toUiQuote, type StoredQuote } from "./quotes.ts";
import { NotFound, type TurnRow } from "./store.ts";
import { mentionsFromJson, type StoredMentions } from "../core/mentions.ts";

/**
 * Messages delivered into a running turn (docs/ui-api.md, docs/agent-bus.md): SendMessage with
 * delivery = steer and the agent bus' send_message with delivery = steer.
 *
 * pending (SteerTurn in the outbox) -> accepted (the provider took it) -> delivered (its user_message item,
 * written by Ingest) | dropped (the turn ended without it, Ingest) -> queued (the next turn, with a reason).
 * A steer for a turn that is no longer running, or one the provider refuses, goes from pending to queued.
 * A steer made from a queued turn (QueueStore.steer) falls back to that turn, at its place in the queue.
 */

export interface SteerRow {
  id: string;
  thread_id: string;
  turn_id: string;
  /** text = what the model gets; with quotes, note (the quotes) + message (the user's text) for the UI. */
  input: { text: string; note?: string; message?: string; quotes?: StoredQuote[] } & StoredMentions;
  author_user_id: string | null;
  agent_call_id: string | null;
  hops: number;
  client_request_id: string | null;
  model: string;
  effort: string;
  /** Override for the fallback turn only ('' = the thread's default); a steer that joins keeps the turn's mode. */
  permission_mode: string;
  status: "pending" | "accepted" | "delivered" | "dropped" | "queued" | "failed";
  reason: string | null;
  queued_turn_id: string | null;
  created_at: Date;
  /** Made from this queued turn (SteerQueuedTurn): it comes back instead of a new turn when the steer falls back. */
  from_turn_id?: string | null;
  /** Joined: the calling thread of an agent's steer. */
  source_thread_id?: string | null;
  /** The platform's note about background tasks that ended (no author; background_task_notes.steer_id). */
  background_note?: boolean;
  /** Joined: the tasks of such a note (item ids). */
  background_item_ids?: string[] | null;
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound>;

export class SteerStore extends Context.Service<
  SteerStore,
  {
    /** A user's steer; an existing one with the same client request id is returned instead. */
    create(input: {
      threadId: string;
      turnId: string;
      text: string;
      userId: string;
      clientRequestId: string;
      model: string;
      effort: string;
      permissionMode: string;
      /** Prepared input (mentions: the composed text, the message and both sets of ranges; quotes); default { text }. */
      input?: SteerRow["input"];
    }): Fx<SteerRow>;
    byClientRequest(threadId: string, clientRequestId: string): Fx<SteerRow | undefined>;
    steer(id: string): Fx<SteerRow>;
    ofThread(threadId: string): Fx<readonly SteerRow[]>;
    accepted(id: string): Fx<SteerRow>;
    /** Steers that did not join their turn (dropped) and still wait for their fallback. */
    dropped(threadId: string): Fx<string[]>;
    /**
     * The steer becomes the next turn (with the reason it did not join the running one). Idempotent: a steer
     * that was already delivered or queued is returned unchanged, without a turn.
     */
    queue(id: string, reason: string): Fx<{ steer: SteerRow; turn?: TurnRow }>;
  }
>()("open-agents/gateway/SteerStore") {
  static readonly layer = Layer.effect(
    SteerStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = `SELECT s.*, c.source_thread_id,
                             CASE WHEN s.background_note THEN ARRAY(SELECT n.item_id FROM background_task_notes n WHERE n.steer_id = s.id ORDER BY n.ended_at, n.item_id) END AS background_item_ids
                        FROM turn_steers s LEFT JOIN agent_bus_calls c ON c.id = s.agent_call_id`;
      const one = (id: string) =>
        sql.unsafe<SteerRow>(`${select} WHERE s.id = $1::uuid`, [id]).pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("steer not found")))),
        );

      const store: SteerStore["Service"] = {
        create: ({ threadId, turnId, text, userId, clientRequestId, model, effort, permissionMode, input }) =>
          Effect.gen(function* () {
            const id = Bun.randomUUIDv7();
            const rows = yield* sql<{ id: string }>`
              INSERT INTO turn_steers (id, thread_id, turn_id, input, author_user_id, client_request_id, model, effort, permission_mode)
              VALUES (${id}::uuid, ${threadId}::uuid, ${turnId}::uuid, ${JSON.stringify(input ?? { text })}::jsonb, ${userId}::uuid,
                      ${clientRequestId || null}, ${model}, ${effort}, ${permissionMode})
              ON CONFLICT (thread_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
              RETURNING id`;
            if (rows[0]) return yield* one(rows[0].id);
            const existing = yield* store.byClientRequest(threadId, clientRequestId);
            return existing ?? (yield* Effect.fail(new NotFound("steer not found")));
          }),

        byClientRequest: (threadId, clientRequestId) =>
          clientRequestId
            ? sql.unsafe<SteerRow>(`${select} WHERE s.thread_id = $1::uuid AND s.client_request_id = $2`, [threadId, clientRequestId]).pipe(
                Effect.map((rows) => rows[0]),
              )
            : Effect.succeed(undefined),

        steer: one,

        ofThread: (threadId) => sql.unsafe<SteerRow>(`${select} WHERE s.thread_id = $1::uuid ORDER BY s.created_at`, [threadId]),

        accepted: (id) =>
          sql`UPDATE turn_steers SET status = 'accepted', updated_at = now() WHERE id = ${id}::uuid AND status = 'pending'`.pipe(
            Effect.andThen(one(id)),
          ),

        dropped: (threadId) =>
          sql<{ id: string }>`SELECT id FROM turn_steers WHERE thread_id = ${threadId}::uuid AND status = 'dropped' ORDER BY created_at`.pipe(
            Effect.map((rows) => rows.map((r) => r.id)),
          ),

        queue: (id, reason) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const locked = yield* sql<SteerRow>`SELECT * FROM turn_steers WHERE id = ${id}::uuid FOR UPDATE`;
              const steer = locked[0];
              if (!steer) return yield* Effect.fail(new NotFound("steer not found"));
              if (steer.status === "delivered" || steer.status === "queued" || steer.status === "failed") return { steer: yield* one(id) };
              // A message steered from the queue goes back to its place there.
              const back = steer.from_turn_id
                ? yield* sql<TurnRow>`
                    UPDATE turns SET status = 'queued', withdrawn = NULL, completed_at = NULL
                     WHERE id = ${steer.from_turn_id}::uuid AND status = 'cancelled' AND withdrawn = 'steered'
                    RETURNING *`
                : [];
              // Like the message would have been queued: a user's turn, or the agent's (same call, same hops).
              const agent = steer.agent_call_id !== null;
              const rows = back[0] ? back : yield* sql<TurnRow>`
                INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, agent_call_id, hops, input, model, effort, permission_mode)
                SELECT ${Bun.randomUUIDv7()}::uuid, ${steer.thread_id}::uuid, coalesce(max(ordinal), 0) + 1, ${agent ? "agent_bus" : "user"},
                       ${steer.author_user_id}::uuid, ${steer.agent_call_id}::uuid, ${steer.hops}, ${JSON.stringify(steer.input)}::jsonb,
                       ${steer.model}, ${steer.effort}, ${steer.permission_mode}
                  FROM turns WHERE thread_id = ${steer.thread_id}::uuid
                RETURNING *`;
              const turn = rows[0]!;
              yield* sql`
                UPDATE turn_steers SET status = 'queued', queued_turn_id = ${turn.id}::uuid, reason = ${reason}, updated_at = now()
                 WHERE id = ${id}::uuid`;
              // The agent hears back when this turn finishes (its source shows the message).
              if (agent) yield* sql`UPDATE agent_bus_calls SET target_turn_id = ${turn.id}::uuid WHERE id = ${steer.agent_call_id}::uuid`;
              return { steer: yield* one(id), turn };
            }),
          ),
      };
      return SteerStore.of(store);
    }),
  );
}

export function toUiSteer(row: SteerRow): ui.Steer {
  return create(ui.SteerSchema, {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    text: row.input.message ?? row.input.text,
    status: row.status === "dropped" ? "accepted" : row.status,
    reason: row.reason ?? "",
    queuedTurnId: row.queued_turn_id ?? "",
    createdAt: timestampFromDate(new Date(row.created_at)),
    sourceThreadId: row.source_thread_id ?? "",
    fromTurnId: row.from_turn_id ?? "",
    quotes: (row.input.quotes ?? []).map(toUiQuote),
    mentions: mentionsFromJson(row.input.mentions),
    backgroundItemIds: row.background_item_ids ?? [],
  });
}
