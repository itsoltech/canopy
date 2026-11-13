import { create, fromJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { RewindThreadSchema, ui, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound, one, type Fx } from "./errors.ts";
import type { ThreadStore } from "./threads-store.ts";
import type { OutboxStore } from "./outbox.ts";
import { rewindTarget, type RewindTarget } from "./rewind-target.ts";
import { rewindDraft } from "./rewind-draft.ts";
import { completeRewind } from "./rewind-result.ts";
import { rewindBoundaries } from "./rewind-boundaries.ts";

export interface RewindRow {
  id: string;
  thread_id: string;
  turn_id: string;
  status: string;
  source_provider_thread_id: string;
  replacement_provider_thread_id: string | null;
  command_id: string;
  draft: JsonValue | null;
  error: string | null;
}

export const rewindResponse = (row: RewindRow) =>
  create(ui.ThreadRewindResponseSchema, {
    rewindId: row.id,
    status: row.status,
    error: row.error ?? "",
    draft: row.status === "completed" && row.draft ? fromJson(ui.TurnSchema, row.draft) : undefined,
  });

export function rewindCommand(point: RewindTarget, spec: ReturnType<ThreadStore["threadSpec"]>) {
  return create(RewindThreadSchema, {
    thread: spec,
    sourceProviderThreadId: point.previous?.provider_session_id ?? point.thread.provider_thread_id ?? "",
    afterProviderTurnRef: point.previous?.provider_turn_ref ?? "",
    empty: !point.previous,
    checkpointId: point.target.id,
    checkpointSessionId: point.target.provider_session_id ?? point.thread.provider_thread_id ?? "",
    cancelledTurnIds: point.suffix.map((turn) => turn.id),
  });
}

/** Intent and outbox share the admission transaction; worker ACK and supersession share the result transaction. */
export function rewindStore(sql: SqlClient.SqlClient, store: () => ThreadStore & OutboxStore) {
  const owned = (owner: string, thread: string, id: string): Fx<RewindRow> =>
    sql<RewindRow>`SELECT r.* FROM thread_rewinds r JOIN threads t ON t.id=r.thread_id
      WHERE r.id=${id}::uuid AND r.thread_id=${thread}::uuid AND t.owner_user_id=${owner}::uuid`.pipe(
      Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("rewind not found")))),
    );

  const enqueue = (
    worker: string,
    thread: string,
    commandId: string,
    value: MessageInitShape<typeof RewindThreadSchema>,
  ) =>
    store().enqueueCommand({
      workerId: worker,
      threadId: thread,
      ttlSeconds: 30 * 86400,
      command: { commandId, kind: { case: "rewindThread", value } },
    });

  return {
    prepareRewind: (owner: string, thread: string, turn: string) =>
      sql.withTransaction(rewindTarget(sql, owner, thread, turn)),
    rewindOperation: owned,
    beginRewind: (
      owner: string,
      request: ui.ThreadRewindRequest,
    ): Fx<{ operation: RewindRow; command?: Command; worker: string }> =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!request.clientRequestId || request.clientRequestId.length > 200)
            return yield* Effect.fail(new Invalid("A rewind request needs a client request id."));

          // Ownership precedes idempotency so another owner cannot learn an operation's outcome.
          const lock = yield* sql`SELECT id FROM threads WHERE id=${request.threadId}::uuid
          AND owner_user_id=${owner}::uuid AND deleted_at IS NULL FOR UPDATE`;

          if (!lock.length) return yield* Effect.fail(new NotFound("thread not found"));

          const existing = (yield* sql<RewindRow>`SELECT * FROM thread_rewinds WHERE thread_id=${request.threadId}::uuid
          AND client_request_id=${request.clientRequestId}`)[0];

          if (existing) {
            if (existing.turn_id !== request.turnId)
              return yield* Effect.fail(new Invalid("This rewind request belongs to another message."));

            return { operation: existing, worker: "" };
          }

          const point = yield* rewindTarget(sql, owner, request.threadId, request.turnId);

          if (request.restoreFiles && point.thread.provider !== "claude")
            return yield* Effect.fail(new Invalid("Files stay as they are. Choose conversation only."));

          if (point.thread.rewind_pending_id)
            return yield* Effect.fail(new Invalid("This thread is already rewinding."));

          if (point.running && !request.stopRunning)
            return yield* Effect.fail(new Invalid("Stop the agent before editing, or choose Stop and edit."));
          const id = Bun.randomUUIDv7();
          const commandId = Bun.randomUUIDv7();
          const draft = yield* rewindDraft(sql, owner, point.target);

          const operation = (yield* sql<RewindRow>`INSERT INTO thread_rewinds
          (id,thread_id,owner_user_id,turn_id,client_request_id,source_provider_thread_id,command_id,restore_files,draft)
          VALUES(${id}::uuid,${request.threadId}::uuid,${owner}::uuid,${request.turnId}::uuid,${request.clientRequestId},
            ${point.thread.provider_thread_id},${commandId}::uuid,${request.restoreFiles},${JSON.stringify(draft)}::jsonb) RETURNING *`)[0];

          if (!operation) return yield* Effect.fail(new Invalid("Could not save the rewind."));
          yield* sql`INSERT INTO thread_rewind_turns(rewind_id,turn_id)
          SELECT ${id}::uuid,id FROM turns WHERE id=ANY(${point.suffix.map((turn) => turn.id)}::uuid[])`;
          yield* cancelRewindWork(sql, request.threadId);
          yield* sql`UPDATE threads SET rewind_pending_id=${id}::uuid WHERE id=${request.threadId}::uuid`;

          const command = yield* enqueue(point.thread.worker_id ?? "", request.threadId, commandId, {
            ...rewindCommand(point, store().threadSpec(yield* store().thread(request.threadId))),
            restoreFiles: request.restoreFiles,
          });

          return { operation, command, worker: point.thread.worker_id ?? "" };
        }),
      ),
    beginRestoreRewind: (owner: string, thread: string, id: string): Fx<{ command?: Command; worker: string }> =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = (yield* sql<{
            worker_id: string;
            rewind_pending_id: string | null;
          }>`SELECT worker_id,rewind_pending_id
          FROM threads WHERE id=${thread}::uuid AND owner_user_id=${owner}::uuid AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`)[0];

          if (!current) return yield* Effect.fail(new NotFound("thread not found"));
          const row = yield* owned(owner, thread, id);

          if (row.status === "restored" || row.status === "restoring") return { worker: current.worker_id };

          if (row.status !== "completed" || current.rewind_pending_id)
            return yield* Effect.fail(new Invalid("This rewind cannot be undone now."));

          const target = yield* one(
            yield* sql<{
              queued_at: Date;
              ordinal: number;
            }>`SELECT queued_at,ordinal FROM turns WHERE id=${row.turn_id}::uuid`,
            "turn",
          );

          yield* rewindBoundaries(sql, thread, target.queued_at, target.ordinal);

          const later = yield* sql`SELECT id FROM turns WHERE thread_id=${thread}::uuid AND rewind_id IS NULL
          AND ordinal>=(SELECT ordinal FROM turns WHERE id=${row.turn_id}::uuid)`;

          const newer = yield* sql`SELECT id FROM thread_rewinds WHERE thread_id=${thread}::uuid AND status='completed'
          AND created_at>(SELECT created_at FROM thread_rewinds WHERE id=${id}::uuid)`;

          if (later.length || newer.length)
            return yield* Effect.fail(new Invalid("Undo is available before another turn or rewind starts."));
          const commandId = Bun.randomUUIDv7();
          yield* sql`UPDATE thread_rewinds SET status='restoring',command_id=${commandId}::uuid WHERE id=${id}::uuid`;
          yield* sql`UPDATE threads SET rewind_pending_id=${id}::uuid WHERE id=${thread}::uuid`;
          const spec = store().threadSpec(yield* store().thread(thread));

          return {
            worker: current.worker_id,
            command: yield* enqueue(current.worker_id, thread, commandId, {
              thread: spec,
              restoreProviderThreadId: row.source_provider_thread_id,
            }),
          };
        }),
      ),
    completeRewind: (commandId: string, result: Parameters<typeof completeRewind>[2]) =>
      completeRewind(sql, commandId, result),
  };
}

const cancelRewindWork = (sql: SqlClient.SqlClient, thread: string) =>
  Effect.gen(function* () {
    yield* sql`UPDATE worker_commands SET status='failed',completed_at=now(),
      result='{"ok":false,"errorCode":"MESSAGE_REWOUND"}'::jsonb
      WHERE thread_id=${thread}::uuid AND kind IN ('startTurn','steerTurn') AND status IN ('pending','delivered')`;
    yield* sql`UPDATE turns SET status='cancelled',completed_at=now() WHERE thread_id=${thread}::uuid AND status='queued'`;
    yield* sql`UPDATE turn_steers SET status='failed',reason='Message rewound',updated_at=now()
    WHERE thread_id=${thread}::uuid AND status IN ('pending','accepted','dropped')`;
    yield* sql`UPDATE interaction_requests SET status='expired',answered_at=now()
    WHERE thread_id=${thread}::uuid AND status='pending'`;
    yield* sql`UPDATE interaction_requests SET answer_delivery='cancelled'
    WHERE thread_id=${thread}::uuid AND answer_delivery IN ('pending','consumed')`;
    yield* sql`UPDATE background_task_notes SET status='cancelled',steer_id=NULL,reason='Message rewound',updated_at=now()
    WHERE thread_id=${thread}::uuid AND status IN ('waiting','steering')`;
    yield* sql`UPDATE agent_bus_calls SET notify_status='cancelled' WHERE (source_thread_id=${thread}::uuid OR
      target_turn_id IN (SELECT id FROM turns WHERE thread_id=${thread}::uuid AND status IN ('running','cancelled')))
    AND notify_status IN ('pending','steering')`;
  });

export type RewindStore = ReturnType<typeof rewindStore>;
