import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ThreadEventSchema, ui, type InteractionRequest, type ThreadEvent } from "@canopy/contracts";
import { decodeUserAnswers } from "@canopy/domain";
import { Effect, Result } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, one, type Fx } from "./errors.ts";
import { writeInteractionTimeline } from "./interaction-timeline.ts";
import { storedQuestions } from "./questions.ts";
import type { InteractionRow } from "./rows.ts";
import { interactionKind, toInteraction } from "./ui-mappers.ts";
import type { ThreadStore } from "./threads-store.ts";

export interface InteractionStore {
  expireInteraction(requestId: string, threadId: string): Fx<ui.Interaction | undefined>;
  /** Pending interactions of the thread's finished turns expire (nothing can answer them any more). */
  expireEndedInteractions(threadId: string): Fx<ui.Interaction[]>;
  recordInteraction(request: InteractionRequest): Fx<ui.Interaction>;
  /** Answered by the user, or by the parent thread's agent (answer_interaction on the agent bus). */
  answerInteraction(
    requestId: string,
    by: { userId: string; botId?: string } | { threadId: string },
    answer: ui.AnswerInteractionRequest,
  ): Fx<ui.Interaction>;
  pendingInteractions(threadId: string): Fx<ui.Interaction[]>;
  interactionAnswer(requestId: string): Fx<{ threadId: string; answer: ui.AnswerInteractionRequest } | undefined>;
  interactionEvent(requestId: string): Fx<{ seq: bigint; event: ThreadEvent } | undefined>;
}

/** Reconnects replay the stored decision, including an expiry acknowledgement. */
function interactionAnswer(sql: SqlClient.SqlClient, requestId: string) {
  return sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid AND status <> 'pending'`.pipe(
    Effect.map((rows) => {
      const row = rows[0];

      if (!row) return undefined;

      if (row.status === "expired")
        return {
          threadId: row.thread_id,
          answer: create(ui.AnswerInteractionRequestSchema, { requestId, cancelled: true }),
        };

      if (!row.response) return undefined;

      return {
        threadId: row.thread_id,
        answer: create(ui.AnswerInteractionRequestSchema, { requestId, ...row.response }),
      };
    }),
  );
}

function interactionExpiry(
  sql: SqlClient.SqlClient,
): Pick<InteractionStore, "expireInteraction" | "expireEndedInteractions"> {
  return {
    expireInteraction: (requestId, threadId) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

          const rows =
            yield* sql<InteractionRow>`UPDATE interaction_requests SET status = 'expired', answered_at = now()
        WHERE id = ${requestId}::uuid AND thread_id = ${threadId}::uuid AND status = 'pending'
          AND (question_call_id IS NULL OR question_wait) RETURNING *`;

          if (!rows[0]) return undefined;
          yield* writeInteractionTimeline(sql, rows[0]);

          return toInteraction(rows[0]);
        }),
      ),
    expireEndedInteractions: (threadId) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

          const rows = yield* sql<InteractionRow>`
              UPDATE interaction_requests q SET status = 'expired', answered_at = now()
                FROM turns u
               WHERE u.id = q.turn_id AND q.thread_id = ${threadId}::uuid AND q.status = 'pending'
                 AND (u.status IN ('completed', 'interrupted', 'failed', 'cancelled') OR q.expires_at <= now())
                 AND (q.question_call_id IS NULL OR q.question_wait)
              RETURNING q.*`;

          for (const row of rows) yield* writeInteractionTimeline(sql, row);

          return rows.map(toInteraction);
        }),
      ),
  };
}

export function interactionStore(sql: SqlClient.SqlClient, self: () => Pick<ThreadStore, "thread">): InteractionStore {
  return {
    ...interactionExpiry(sql),
    recordInteraction: (request) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const thread = yield* self().thread(request.threadId);
          yield* sql`SELECT id FROM threads WHERE id = ${request.threadId}::uuid FOR UPDATE`;

          const known =
            yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${request.requestId}::uuid`;

          if (known[0]) {
            if (known[0].thread_id !== request.threadId)
              return yield* Effect.fail(new Invalid("interaction belongs to another thread"));

            if (request.cancelled && known[0].status === "pending") {
              const expired = yield* sql<InteractionRow>`UPDATE interaction_requests
                SET status = 'expired', answered_at = now() WHERE id = ${request.requestId}::uuid RETURNING *`;

              yield* writeInteractionTimeline(sql, expired[0]!);

              return toInteraction(expired[0]!);
            }

            return toInteraction(known[0]);
          }

          const rows = yield* sql<InteractionRow>`
                INSERT INTO interaction_requests (id, thread_id, turn_id, item_id, kind, tool_name, request, routed_to, expires_at)
                VALUES (${request.requestId}::uuid, ${request.threadId}::uuid,
                        (SELECT id FROM turns WHERE id = ${request.turnId || null}::uuid AND thread_id = ${request.threadId}::uuid),
                        ${request.itemId || null}, ${interactionKind(request.kind)}, ${request.toolName}, ${request.requestJson || "{}"}::jsonb,
                        ${thread.interaction_route}, ${request.expiresAt ? timestampDate(request.expiresAt) : null})
                ON CONFLICT (id) DO UPDATE SET request = interaction_requests.request
                RETURNING *`;

          const row = yield* one(rows, "interaction");

          const ended = yield* sql`SELECT id FROM turns WHERE id = ${row.turn_id}::uuid
            AND status IN ('completed', 'interrupted', 'failed', 'cancelled')`;

          if (request.cancelled || ended.length) {
            yield* sql`UPDATE interaction_requests SET status = 'expired', answered_at = now() WHERE id = ${row.id}::uuid`;
            row.status = "expired";
          }

          yield* writeInteractionTimeline(sql, row);

          return toInteraction(row);
        }),
      ),

    answerInteraction: (requestId, by, answer) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* one(
              yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid`,
              "interaction",
            );

            yield* sql`SELECT id FROM threads WHERE id = ${found.thread_id}::uuid FOR UPDATE`;

            const current = yield* one(
              yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${requestId}::uuid FOR UPDATE`,
              "interaction",
            );

            if (current.status === "expired") return current;

            if (current.status !== "pending")
              return yield* Effect.fail(new Invalid(`interaction is already ${current.status}`));

            const ended = yield* sql`SELECT id FROM turns WHERE id = ${current.turn_id}::uuid
            AND status IN ('completed', 'interrupted', 'failed', 'cancelled')`;

            if (
              (ended.length || (current.expires_at && new Date(current.expires_at).getTime() <= Date.now())) &&
              (!current.question_call_id || current.question_wait)
            ) {
              const rows =
                yield* sql<InteractionRow>`UPDATE interaction_requests SET status = 'expired', answered_at = now()
              WHERE id = ${requestId}::uuid RETURNING *`;

              yield* writeInteractionTimeline(sql, rows[0]!);

              return rows[0]!;
            }

            if (current.question_call_id && !answer.cancelled) {
              const decoded = decodeUserAnswers(answer.answerJson, storedQuestions(current.request));

              if (Result.isFailure(decoded)) return yield* Effect.fail(new Invalid(decoded.failure));
            }

            const status = answer.cancelled
              ? "cancelled"
              : current.kind === "permission"
                ? answer.allow
                  ? "allowed"
                  : "declined"
                : "answered";

            // Cancellation has no author (interaction_requests_answered_by).
            const userId = "userId" in by && !answer.cancelled ? by.userId : null;
            const threadId = "threadId" in by && !answer.cancelled ? by.threadId : null;

            const rows = yield* sql<InteractionRow>`
                UPDATE interaction_requests SET status = ${status}, answered_by = ${userId}::uuid, answered_by_thread_id = ${threadId}::uuid,
                       answered_by_bot_id = ${"botId" in by && by.botId && !answer.cancelled ? by.botId : null}::uuid,
                       answered_at = now(),
                       response = ${JSON.stringify({ allow: answer.allow, allowForSession: answer.allowForSession, message: answer.message, answerJson: answer.answerJson, cancelled: answer.cancelled })}::jsonb,
                       answer_delivery = CASE WHEN question_call_id IS NOT NULL THEN 'pending' ELSE NULL END
                 WHERE id = ${requestId}::uuid RETURNING *`;

            // The parent agent no longer needs the turn that would have asked it.
            yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE interaction_request_id = ${requestId}::uuid AND status = 'queued'`;
            const row = yield* one(rows, "interaction");
            yield* writeInteractionTimeline(sql, row);

            return row;
          }),
        )
        .pipe(Effect.map(toInteraction)),

    interactionEvent: (requestId) =>
      sql<{ seq: string; payload: JsonValue }>`
            SELECT e.seq, e.payload FROM interaction_requests q
              JOIN thread_items i ON i.thread_id = q.thread_id AND i.item_id = 'interaction-' || q.id::text
              JOIN thread_events e ON e.thread_id = i.thread_id AND e.seq = i.last_seq
             WHERE q.id = ${requestId}::uuid`.pipe(
        Effect.map((rows) =>
          rows[0] ? { seq: BigInt(rows[0].seq), event: fromJson(ThreadEventSchema, rows[0].payload) } : undefined,
        ),
      ),

    pendingInteractions: (threadId) =>
      sql<InteractionRow>`SELECT * FROM interaction_requests WHERE thread_id = ${threadId}::uuid AND status = 'pending' ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(toInteraction)),
      ),

    interactionAnswer: (requestId) => interactionAnswer(sql, requestId),
  };
}
