import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { toUiQuote, type StoredQuote } from "./quotes.ts";
import { Invalid, NotFound, toUiSender, type SenderColumns, type TurnRow } from "./store.ts";
import { toUiAttachment } from "./attachments.ts";
import { createSteer } from "./steer-create.ts";
import { mentionsFromJson, type StoredMentions } from "../core/mentions.ts";
import { storedShellResult } from "./shell-input.ts";

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
  input: { text: string; note?: string; message?: string; quotes?: StoredQuote[] } & StoredMentions &
    Pick<
      TurnRow["input"],
      "attachments" | "sender" | "sourceKind" | "sourceStatus" | "shellCommand" | "shellInputId" | "shellResult"
    >;
  author_user_id: string | null;
  agent_call_id: string | null;
  bot_call_id?: string | null;
  /** A platform report about this call's target, rather than another send_message. */
  notification_call_id?: string | null;
  hops: number;
  linked_call_id?: string | null;
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
  /** Joined: the calling thread of an agent's steer, and who it is (AgentSender). */
  source_thread_id?: string | null;
  /** The platform's note about background tasks that ended (no author; background_task_notes.steer_id). */
  background_note?: boolean;
  /** Joined: the tasks of such a note (item ids). */
  background_item_ids?: string[] | null;
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;

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
      linked?: { callId: string; hops: number };
    }): Fx<SteerRow>;
    byClientRequest(threadId: string, clientRequestId: string): Fx<SteerRow | undefined>;
    steer(id: string): Fx<SteerRow>;
    ofThread(threadId: string): Fx<readonly SteerRow[]>;
    accepted(id: string): Fx<SteerRow>;
    failed(id: string, reason: string): Fx<SteerRow>;
    /** Steers that did not join their turn (dropped) and still wait for their fallback. */
    dropped(threadId: string): Fx<string[]>;
    /**
     * The steer becomes the next turn (with the reason it did not join the running one). Idempotent: a steer
     * that was already delivered or queued is returned unchanged, without a turn.
     */
    queue(id: string, reason: string): Fx<{ steer: SteerRow; turn?: TurnRow }>;
    /** Serialize steer outbox creation with recipient observation and fallback. */
    whilePending<A, E, R>(
      id: string,
      action: Effect.Effect<A, E, R>,
    ): Effect.Effect<A | undefined, E | SqlError.SqlError, R>;
  }
>()("canopy/gateway/SteerStore") {
  static readonly layer = Layer.effect(
    SteerStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // An answer to the agent's own ask_user comes from whoever answered (a parent thread, or nobody: you or a bot), not from itself.
      const source = `CASE WHEN s.notification_call_id IS NOT NULL THEN c.target_thread_id
        WHEN c.tool = 'ask_user' THEN (SELECT q.answered_by_thread_id FROM interaction_requests q WHERE q.question_call_id = c.id)
        ELSE c.source_thread_id END`;

      const select = `
        SELECT s.*, ${source} AS source_thread_id,
               st.title AS source_title, st.provider AS source_provider, st.provider_profile_id AS source_profile_id,
               coalesce(nullif(su.model, ''), st.settings ->> 'model', '') AS source_model, st.project_id AS source_project_id,
               st.worker_id AS source_worker_id,
               CASE WHEN s.background_note THEN ARRAY(SELECT n.item_id FROM background_task_notes n WHERE n.steer_id = s.id ORDER BY n.ended_at, n.item_id) END AS background_item_ids
          FROM turn_steers s LEFT JOIN agent_bus_calls c ON c.id = coalesce(s.agent_call_id, s.notification_call_id)
          LEFT JOIN threads st ON st.id = ${source}
          LEFT JOIN turns su ON su.id = CASE WHEN s.notification_call_id IS NOT NULL THEN c.target_turn_id ELSE c.source_turn_id END`;

      const one = (id: string) =>
        sql
          .unsafe<SteerRow>(`${select} WHERE s.id = $1::uuid`, [id])
          .pipe(
            Effect.flatMap((rows) =>
              rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("steer not found")),
            ),
          );

      const store: SteerStore["Service"] = {
        whilePending: (id, action) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM threads WHERE id = (SELECT thread_id FROM turn_steers WHERE id = ${id}::uuid) FOR UPDATE`;
              const rows = yield* sql`SELECT id FROM turn_steers WHERE id = ${id}::uuid AND status = 'pending'`;

              return rows.length > 0 ? yield* action : undefined;
            }),
          ),
        create: (input) => createSteer(sql, input).pipe(Effect.flatMap(one)),

        byClientRequest: (threadId, clientRequestId) =>
          clientRequestId
            ? sql
                .unsafe<SteerRow>(`${select} WHERE s.thread_id = $1::uuid AND s.client_request_id = $2`, [
                  threadId,
                  clientRequestId,
                ])
                .pipe(Effect.map((rows) => rows[0]))
            : Effect.succeed(undefined),

        steer: one,

        ofThread: (threadId) =>
          sql.unsafe<SteerRow>(`${select} WHERE s.thread_id = $1::uuid ORDER BY s.created_at`, [threadId]),

        accepted: (id) =>
          sql`UPDATE turn_steers SET status = 'accepted', updated_at = now() WHERE id = ${id}::uuid AND status = 'pending'`.pipe(
            Effect.andThen(one(id)),
          ),
        failed: (id, reason) =>
          sql`UPDATE turn_steers SET status = 'failed', reason = ${reason}, updated_at = now() WHERE id = ${id}::uuid AND status NOT IN ('delivered', 'queued')`.pipe(
            Effect.andThen(one(id)),
          ),

        dropped: (threadId) =>
          sql<{
            id: string;
          }>`SELECT id FROM turn_steers WHERE thread_id = ${threadId}::uuid AND status = 'dropped' ORDER BY created_at`.pipe(
            Effect.map((rows) => rows.map((r) => r.id)),
          ),

        queue: (id, reason) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM threads WHERE id = (SELECT thread_id FROM turn_steers WHERE id = ${id}::uuid) FOR UPDATE`;
              const locked = yield* sql<SteerRow>`SELECT * FROM turn_steers WHERE id = ${id}::uuid FOR UPDATE`;
              const steer = locked[0];

              if (!steer) return yield* Effect.fail(new NotFound("steer not found"));

              if (steer.status === "delivered" || steer.status === "queued" || steer.status === "failed")
                return { steer: yield* one(id) };

              const calls = yield* sql<{
                tool: string;
              }>`SELECT tool FROM agent_bus_calls WHERE id = ${steer.agent_call_id}::uuid`;

              if (calls[0]?.tool === "send_message" && steer.input.note && !steer.input.note.includes("queued while")) {
                const note = `${steer.input.note.slice(0, -1)}, queued while your previous turn was running:`;
                steer.input = { ...steer.input, note, text: `${note}\n\n${steer.input.message ?? ""}` };
              }

              // A message steered from the queue goes back to its place there.
              const back = steer.from_turn_id
                ? yield* sql<TurnRow>`
                    UPDATE turns SET status = 'queued', withdrawn = NULL, completed_at = NULL, input = ${JSON.stringify(steer.input)}::jsonb
                     WHERE id = ${steer.from_turn_id}::uuid AND status = 'cancelled' AND withdrawn = 'steered'
                    RETURNING *`
                : [];

              // Like the message would have been queued: a user's turn, or the agent's (same call, same hops).
              const agent = steer.agent_call_id !== null || !!steer.notification_call_id;
              const bot = steer.bot_call_id != null;

              const rows = back[0]
                ? back
                : yield* sql<TurnRow>`
                INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, agent_call_id, bot_call_id, linked_call_id, hops, input, model, effort, permission_mode)
                SELECT ${Bun.randomUUIDv7()}::uuid, ${steer.thread_id}::uuid, coalesce(max(ordinal), 0) + 1, ${steer.linked_call_id ? "linked_agent" : bot ? "bot" : agent ? "agent_bus" : "user"},
                       ${steer.author_user_id}::uuid, ${steer.agent_call_id ?? steer.notification_call_id ?? null}::uuid, ${steer.bot_call_id ?? null}::uuid, ${steer.linked_call_id ?? null}::uuid, ${steer.hops}, ${JSON.stringify(steer.input)}::jsonb,
                       ${steer.model}, ${steer.effort}, ${steer.permission_mode}
                  FROM turns WHERE thread_id = ${steer.thread_id}::uuid
                RETURNING *`;

              const turn = rows[0]!;

              if (steer.input.attachments?.length)
                yield* sql`UPDATE attachments SET turn_id = ${turn.id}::uuid
                  WHERE thread_id = ${steer.thread_id}::uuid AND id = ANY(${steer.input.attachments.map((a) => a.id)}::uuid[])`;

              if (steer.linked_call_id)
                yield* sql`UPDATE computer_agent_calls SET target_turn_id=${turn.id}::uuid WHERE target_steer_id=${id}::uuid AND direction='incoming' AND NOT detached`;
              yield* sql`
                UPDATE turn_steers SET status = 'queued', queued_turn_id = ${turn.id}::uuid, reason = ${reason}, updated_at = now()
                 WHERE id = ${id}::uuid`;

              // The agent hears back when this turn finishes (its source shows the message).
              if (steer.notification_call_id) {
                yield* sql`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = ${turn.id}::uuid
                  WHERE id = ${steer.notification_call_id}::uuid AND notify_status = 'steering'`;
              } else if (agent)
                yield* sql`UPDATE agent_bus_calls SET target_turn_id = ${turn.id}::uuid WHERE id = ${steer.agent_call_id}::uuid`;

              return { steer: yield* one(id), turn };
            }),
          ),
      };

      return SteerStore.of(store);
    }),
  );
}

export function toUiSteer(row: SteerRow & SenderColumns): ui.Steer {
  const sender = toUiSender(row, row.input.sender);

  return create(ui.SteerSchema, {
    id: row.id,
    shellCommand: row.input.shellCommand,
    shellResult: storedShellResult(row.input.shellResult),
    inputText: row.input.text,
    threadId: row.thread_id,
    turnId: row.turn_id,
    text: row.input.message ?? row.input.text,
    status: row.status === "dropped" ? "accepted" : row.status,
    reason: row.reason ?? "",
    queuedTurnId: row.queued_turn_id ?? "",
    createdAt: timestampFromDate(new Date(row.created_at)),
    sourceThreadId: sender?.threadId || row.source_thread_id || "",
    fromTurnId: row.from_turn_id ?? "",
    quotes: (row.input.quotes ?? []).map(toUiQuote),
    attachments: (row.input.attachments ?? []).map(toUiAttachment),
    mentions: mentionsFromJson(row.input.mentions),
    backgroundItemIds: row.background_item_ids ?? [],
    ...(sender && { sender }),
  });
}
