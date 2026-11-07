import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BusCallStore } from "./bus-calls.ts";
import { consumeMessages } from "./bus-messages.ts";
import { observedMessageCalls, observedSummaryTurns } from "./notification-observation.ts";
import { consumeNotifications, insertCall, turnRef } from "./agent-bus-queries.ts";
import { isUniqueViolation } from "./agent-bus-types.ts";

export const recordBusCall = (
  sql: SqlClient.SqlClient,
  { source, tool, args, ok, result, error, observedTurnIds }: Parameters<BusCallStore["recordCall"]>[0],
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const observed = observedTurnIds ?? observedSummaryTurns(tool, result);

        if (ok && ["wait_threads", "get_thread", "read_thread"].includes(tool)) {
          yield* sql`SELECT id FROM threads WHERE id = ${source.threadId}::uuid FOR UPDATE`;
          yield* consumeMessages(
            sql,
            source.threadId,
            observedMessageCalls(result),
            tool === "wait_threads" ? "consumed_by_wait" : "consumed_by_read",
          );
        }

        if (ok && observed.length > 0)
          yield* consumeNotifications(
            sql,
            source.threadId,
            tool === "wait_threads" ? "consumed_by_wait" : "consumed_by_read",
            { turnIds: observed },
          );

        const waiting = yield* sql`UPDATE agent_bus_calls SET status = ${ok ? "completed" : "failed"},
    result = ${result === undefined ? null : JSON.stringify(result)}::jsonb, error = ${error ?? null}, completed_at = now()
    WHERE id = ${source.callId}::uuid AND source_thread_id = ${source.threadId}::uuid
      AND status = 'requested' AND tool = 'wait_threads' RETURNING id`;

        if (waiting.length > 0) return;
        yield* insertCall(sql, {
          source,
          tool,
          args,
          status: ok ? "completed" : "failed",
          ...(result !== undefined && { result }),
          ...(error !== undefined && { error }),
          ...(ok &&
            (tool === "spawn_thread" || tool === "send_message") && {
              // Linked actions persist their executable reference at the remote home.
              hops:
                ((yield* sql<{ hops: number }>`SELECT hops FROM turns WHERE id=${turnRef(sql, source)}`)[0]?.hops ??
                  0) + 1,
            }),
        });
      }),
    )
    .pipe(
      // A concurrent duplicate stored it first: same call, same outcome; its observation rolls back.
      Effect.catchTag("SqlError", (e) => (isUniqueViolation(e) ? Effect.void : Effect.fail(e))),
      Effect.asVoid,
    );
