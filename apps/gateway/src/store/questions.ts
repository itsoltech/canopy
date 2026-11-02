import { create, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { CommandSchema, type ui } from "@open-agents/contracts";
import { questionAnswerInput, questionResult, type AgentBusArgs, type UserQuestion } from "@open-agents/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { Invalid, NotFound, toInteraction, type InteractionRow, type TurnRow } from "./store.ts";
import type { CallSource } from "./agent-bus.ts";
import { writeInteractionTimeline } from "./interaction-timeline.ts";

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;
export interface QuestionDelivery { threadId: string; turn?: TurnRow; steerId?: string }
export interface QuestionStore {
  askUser(source: CallSource, args: AgentBusArgs["ask_user"], hops: number): Fx<ui.Interaction>;
  getAnswers(source: CallSource, id: string, consume: boolean): Fx<JsonValue>;
  deliverAnswers(): Fx<QuestionDelivery[]>;
}

export function questionStore(sql: SqlClient.SqlClient): QuestionStore {
  return {
    askUser: (source, args, hops) => sql.withTransaction(Effect.gen(function* () {
      const threads = yield* sql<{ interaction_route: string }>`SELECT interaction_route FROM threads WHERE id = ${source.threadId}::uuid FOR UPDATE`;
      if (!threads[0]) return yield* Effect.fail(new NotFound("thread not found"));
      const existing = yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE question_call_id = ${source.callId}::uuid`;
      if (existing[0]) return toInteraction(existing[0]);
      const turn = yield* sql`SELECT id FROM turns WHERE id = ${source.turnId || null}::uuid AND thread_id = ${source.threadId}::uuid`;
      if (!turn[0]) return yield* Effect.fail(new Invalid("ask_user requires a turn"));
      yield* sql`
        INSERT INTO agent_bus_calls(id, source_thread_id, source_turn_id, source_item_id, tool, arguments, status, result, completed_at, hops, target_thread_id)
        VALUES (${source.callId}::uuid, ${source.threadId}::uuid, ${source.turnId}::uuid, ${source.itemId}, 'ask_user', ${JSON.stringify(args)}::jsonb,
                'completed', ${JSON.stringify(questionResult(source.callId, "pending", null))}::jsonb, now(), ${hops}, ${source.threadId}::uuid)`;
      const rows = yield* sql<InteractionRow>`
        INSERT INTO interaction_requests(id, thread_id, turn_id, item_id, kind, tool_name, request, routed_to, question_call_id, question_wait)
        VALUES (${source.callId}::uuid, ${source.threadId}::uuid, ${source.turnId}::uuid, ${source.itemId}, 'question', 'ask_user',
                ${JSON.stringify(args)}::jsonb, ${threads[0].interaction_route}, ${source.callId}::uuid, ${args.wait}) RETURNING *`;
      yield* writeInteractionTimeline(sql, rows[0]!);
      return toInteraction(rows[0]!);
    })),

    getAnswers: (source, id, consume) => sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT id FROM threads WHERE id = ${source.threadId}::uuid FOR UPDATE`;
      const rows = yield* sql<InteractionRow>`SELECT * FROM interaction_requests WHERE id = ${id}::uuid AND thread_id = ${source.threadId}::uuid AND question_call_id IS NOT NULL FOR UPDATE`;
      const row = rows[0];
      if (!row) return yield* Effect.fail(new NotFound("question set not found in this thread"));
      const result = questionResult(row.id, row.status, row.response as { answerJson?: string } | null);
      const alive = yield* sql`SELECT id FROM turns WHERE id = ${source.turnId || null}::uuid AND thread_id = ${source.threadId}::uuid AND status = 'running'`;
      if (consume && row.question_wait && row.answer_delivery === "pending") {
        // A process killed while waiting must not consume the answer on behalf of the resumed agent.
        if (alive[0]) {
          yield* sql`UPDATE interaction_requests SET answer_delivery = 'consumed' WHERE id = ${id}::uuid`;
          yield* sql`UPDATE agent_bus_calls SET result = ${JSON.stringify(result)}::jsonb WHERE id = ${row.question_call_id!}::uuid`;
        }
      }
      return row.status === "pending" ? { ...result, waiting: alive.length > 0 } : result;
    })),

    deliverAnswers: () => Effect.gen(function* () {
      // No transport acknowledgement exists for a tool result. A crashed sync turn may have died
      // after DB consumption and before receiving it; redeliver on interruption/failure as well.
      const due = yield* sql<{ id: string; thread_id: string }>`
        SELECT q.id, q.thread_id FROM interaction_requests q LEFT JOIN turns u ON u.id = q.turn_id
        WHERE q.answer_delivery = 'pending' OR (q.answer_delivery = 'consumed' AND u.status IN ('interrupted', 'failed')) ORDER BY q.created_at`;
      const delivered: QuestionDelivery[] = [];
      for (const candidate of due) {
        const delivery = yield* sql.withTransaction(Effect.gen(function* () {
          const threads = yield* sql<{ archived_at: Date | null; worker_id: string | null }>`SELECT archived_at, worker_id FROM threads WHERE id = ${candidate.thread_id}::uuid FOR UPDATE`;
          const rows = yield* sql<InteractionRow & { hops: number; asking_status: string }>`
            SELECT q.*, c.hops, u.status AS asking_status FROM interaction_requests q
              JOIN agent_bus_calls c ON c.id = q.question_call_id LEFT JOIN turns u ON u.id = q.turn_id
             WHERE q.id = ${candidate.id}::uuid AND (q.answer_delivery = 'pending' OR
               (q.answer_delivery = 'consumed' AND u.status IN ('interrupted', 'failed'))) FOR UPDATE OF q`;
          const row = rows[0];
          if (!row) return undefined;
          if (threads[0]?.archived_at) {
            yield* sql`UPDATE interaction_requests SET answer_delivery = 'cancelled' WHERE id = ${row.id}::uuid`;
            return undefined;
          }
          // The active sync tool receives the answer itself. If its turn ends without consuming it,
          // onTurnFinished / restart reconciliation / the sweep delivers it here as a new turn.
          if (row.question_wait && row.asking_status === "running") return undefined;
          const input = questionAnswerInput(row.id, row.status, row.response as { answerJson?: string } | null,
            (row.request as unknown as { questions: UserQuestion[] }).questions);
          const running = yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${row.thread_id}::uuid AND status = 'running' LIMIT 1`;
          if (!row.question_wait && running[0] && threads[0]?.worker_id) {
            const steerId = Bun.randomUUIDv7();
            yield* sql`INSERT INTO turn_steers(id, thread_id, turn_id, input, agent_call_id, hops)
              VALUES (${steerId}::uuid, ${row.thread_id}::uuid, ${running[0].id}::uuid, ${JSON.stringify(input)}::jsonb, ${row.question_call_id!}::uuid, ${row.hops})`;
            // Steer and command are one durable outbox write; a crash before dispatch cannot lose either.
            const command = create(CommandSchema, { commandId: steerId, kind: { case: "steerTurn", value: { threadId: row.thread_id, turnId: running[0].id, inputId: steerId, input } } });
            yield* sql`INSERT INTO worker_commands(id, worker_id, thread_id, kind, payload, expires_at)
              VALUES (${steerId}::uuid, ${threads[0].worker_id}::uuid, ${row.thread_id}::uuid, 'steerTurn', ${toBinary(CommandSchema, command)}, now() + interval '24 hours')`;
            yield* sql`UPDATE interaction_requests SET answer_delivery = 'delivered', answer_steer_id = ${steerId}::uuid WHERE id = ${row.id}::uuid`;
            return { threadId: row.thread_id, steerId };
          }
          const turns = yield* sql<TurnRow>`
            INSERT INTO turns(id, thread_id, ordinal, trigger, agent_call_id, hops, input)
            SELECT ${Bun.randomUUIDv7()}::uuid, ${row.thread_id}::uuid, coalesce(max(ordinal), 0) + 1, 'agent_bus', ${row.question_call_id!}::uuid, ${row.hops}, ${JSON.stringify(input)}::jsonb
              FROM turns WHERE thread_id = ${row.thread_id}::uuid RETURNING *`;
          yield* sql`UPDATE agent_bus_calls SET target_turn_id = ${turns[0]!.id}::uuid WHERE id = ${row.question_call_id!}::uuid`;
          yield* sql`UPDATE interaction_requests SET answer_delivery = 'delivered', answer_turn_id = ${turns[0]!.id}::uuid WHERE id = ${row.id}::uuid`;
          return { threadId: row.thread_id, turn: turns[0]! };
        }));
        if (delivery) delivered.push(delivery);
      }
      return delivered;
    }),
  };
}
