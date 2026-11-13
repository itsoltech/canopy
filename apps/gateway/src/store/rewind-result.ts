import { create, toJson } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { CommandResultSchema, NoticeLevel, ThreadEventSchema, type CommandResult } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { insertEvent } from "./ingest-events.ts";
import type { RewindRow } from "./rewinds.ts";

/** Never ACK the outbox separately: a crash must replay the worker's remembered result. */
export const completeRewind = (sql: SqlClient.SqlClient, commandId: string, result: CommandResult) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const found = (yield* sql<RewindRow>`SELECT * FROM thread_rewinds WHERE command_id=${commandId}::uuid`)[0];

      if (!found) return undefined;

      const thread = (yield* sql<{
        last_seq: bigint;
      }>`SELECT last_seq FROM threads WHERE id=${found.thread_id}::uuid FOR UPDATE`)[0];

      const row = (yield* sql<RewindRow>`SELECT * FROM thread_rewinds WHERE id=${found.id}::uuid FOR UPDATE`)[0];

      if (!thread || !row || !["pending", "restoring"].includes(row.status)) return undefined;
      const restore = row.status === "restoring";
      const native = result.rewind?.providerThreadId;
      const ok = result.ok && Boolean(native) && (!restore || native === row.source_provider_thread_id);
      const error = ok ? "" : result.errorMessage || "The agent could not rewind this thread. Try again.";
      const seq = BigInt(thread.last_seq) + 1n;

      const turns = ok
        ? yield* sql<{ id: string }>`UPDATE turns SET
      rewind_id=CASE WHEN ${restore} THEN NULL ELSE ${row.id}::uuid END,
      status=CASE WHEN status='running' THEN 'interrupted' ELSE status END,
      interrupt_source=CASE WHEN status='running' THEN 'system' ELSE interrupt_source END,
      interrupt_reason=CASE WHEN status='running' THEN 'Message rewound' ELSE interrupt_reason END,
      completed_at=CASE WHEN status='running' THEN now() ELSE completed_at END
      WHERE thread_id=${row.thread_id}::uuid AND
        (CASE WHEN ${restore} THEN rewind_id=${row.id}::uuid
          ELSE rewind_id IS NULL AND ordinal>=(SELECT ordinal FROM turns WHERE id=${row.turn_id}::uuid) END)
      RETURNING id`
        : [];

      const status = ok ? (restore ? "restored" : "completed") : restore ? "completed" : "failed";
      yield* sql`UPDATE thread_rewinds SET status=${status},error=${error || null},completed_at=now(),
      completed_seq=CASE WHEN ${ok && !restore} THEN ${seq} ELSE completed_seq END,
      restored_seq=CASE WHEN ${ok && restore} THEN ${seq} ELSE restored_seq END,
      replacement_provider_thread_id=CASE WHEN ${ok && !restore} THEN ${native ?? null} ELSE replacement_provider_thread_id END
      WHERE id=${row.id}::uuid`;

      const event = create(ThreadEventSchema, {
        eventId: Bun.randomUUIDv7(),
        threadId: row.thread_id,
        occurredAt: timestampNow(),
        body: {
          case: "notice",
          value: {
            level: ok ? NoticeLevel.INFO : NoticeLevel.WARNING,
            code: ok ? (restore ? "thread_rewind_restored" : "thread_rewound") : "thread_rewind_failed",
            message: ok
              ? restore
                ? "Rewound messages restored. Files stay as they are."
                : "Messages rewound."
              : error,
            dataJson: JSON.stringify({ rewind_id: row.id, turn_ids: turns.map((turn) => turn.id) }),
          },
        },
      });

      yield* insertEvent(sql, row.thread_id, seq, event, "gateway");
      yield* sql`UPDATE threads SET provider_thread_id=CASE WHEN ${ok} THEN ${native ?? null} ELSE provider_thread_id END,
      rewind_pending_id=NULL,last_seq=${seq},status=CASE WHEN ${ok} THEN 'idle' ELSE status END
      WHERE id=${row.thread_id}::uuid`;
      yield* sql`UPDATE worker_commands SET status=${ok ? "completed" : "failed"},
      result=${JSON.stringify(toJson(CommandResultSchema, result))}::jsonb,completed_at=now() WHERE id=${commandId}::uuid`;

      return { threadId: row.thread_id, turns: turns.map((turn) => turn.id), event, seq };
    }),
  );
