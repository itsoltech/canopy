import { create, toBinary } from "@bufbuild/protobuf";
import { NoticeLevel, ThreadEventSchema, type ThreadEvent } from "@canopy/contracts";
import { Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

const decodeCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

export function sqlErrorCode(error: SqlError.SqlError): string | undefined {
  const decoded = decodeCode(error.reason.cause);

  return Option.isSome(decoded) && /^[0-9A-Z]{5}$/.test(decoded.value.code) ? decoded.value.code : undefined;
}

/** Invalid data and violated constraints cannot succeed by replaying the same event. */
export function dataErrorCode(error: SqlError.SqlError): string | undefined {
  const code = sqlErrorCode(error);

  return code?.startsWith("22") || code?.startsWith("23") ? code : undefined;
}

/** Original protobuf bytes never pass through text/jsonb. The caller commits this with marker + cursor. */
export const quarantineEvent = (
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  event: ThreadEvent,
  code: string,
  reason = "data_error",
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO worker_event_quarantine(worker_id,journal_id,thread_id,event_id,journal_seq,sqlstate,payload,reason)
      VALUES(${workerId}::uuid,${journalId},${event.threadId}::uuid,${event.eventId}::uuid,${event.journalSeq},${code},${toBinary(ThreadEventSchema, event)},${reason})
      ON CONFLICT (event_id) DO NOTHING`;

    return create(ThreadEventSchema, {
      threadId: event.threadId,
      eventId: event.eventId,
      journalSeq: event.journalSeq,
      occurredAt: event.occurredAt,
      body: {
        case: "notice",
        value: {
          level: NoticeLevel.WARNING,
          code: "event_quarantined",
          message: "Some output could not be saved. Later output will still appear.",
          dataJson: JSON.stringify({ sqlstate: code }),
        },
      },
    });
  });

/** Bot persistence also has projections in text/jsonb, despite storing its original event as bytea. */
export const withEventQuarantine = <A>(
  sql: SqlClient.SqlClient,
  workerId: string,
  journalId: string,
  event: ThreadEvent,
  persist: (event: ThreadEvent) => Effect.Effect<A, SqlError.SqlError>,
) =>
  persist(event).pipe(
    Effect.catchTag("SqlError", (error) => {
      const code = dataErrorCode(error);

      if (!code) return Effect.fail(error);

      return sql.withTransaction(
        Effect.gen(function* () {
          const marker = yield* quarantineEvent(sql, workerId, journalId, event, code);
          const result = yield* persist({ ...marker, turnId: event.turnId });
          yield* sql.afterCommit(
            Effect.logWarning("Worker event quarantined", {
              workerId,
              threadId: event.threadId,
              eventId: event.eventId,
              journalSeq: String(event.journalSeq),
              sqlstate: code,
            }),
          );

          return result;
        }),
      );
    }),
  );
