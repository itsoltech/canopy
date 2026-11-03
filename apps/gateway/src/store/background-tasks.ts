import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { ItemSchema, type BackgroundTask } from "@canopy/contracts";
import {
  backgroundEndReason,
  backgroundOutcome,
  backgroundTaskNote,
  backgroundTitle,
  formatDuration,
  outputTail,
  type BackgroundOutcome,
  type BackgroundTaskEnd,
} from "@canopy/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import type { TurnRow } from "./store.ts";

/**
 * Background tasks of a thread for its agent (docs/execution.md, "Zadania w tle", "Pobudka"):
 *
 * - the agent's tools read them from the timeline (thread_items of type background_task), so tasks of earlier worker
 *   processes are there too, with how and why they ended;
 * - every end gets a note (background_task_notes, written by Ingest with the end). deliver() hands waiting notes to
 *   the agent: steered into the running turn, else a turn of their own (trigger background_task, hops of the
 *   starting turn + 1); a note that may not wake the thread (stopped by the user, hop limit) waits for the next turn
 *   that runs. A Claude task that completed by itself first gets `graceMs` for Claude's own wake-up turn.
 */

/** A task as the agent's tools report it. */
export interface BackgroundTaskView {
  readonly task_id: string;
  /** The harness's own id (Codex process id, Claude task id). */
  readonly provider_task_id: string;
  readonly title: string;
  readonly command: string;
  readonly kind: string;
  readonly status: BackgroundOutcome;
  /** In plain words: "completed with exit code 0", "stopped because the worker was shut down …". */
  readonly reason: string;
  readonly stop_reason?: string;
  readonly exit_code?: number;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly duration?: string;
  readonly duration_seconds?: number;
  readonly started_in_turn_id?: string;
  readonly started_in_turn?: number;
}

export interface BackgroundTaskDetail extends BackgroundTaskView {
  readonly output: string;
  readonly output_truncated: boolean;
}

interface TaskRow {
  item_id: string;
  turn_id: string | null;
  status: string;
  content: JsonValue;
  turn_ordinal: number | null;
}

interface NoteRow extends TaskRow {
  wake: boolean;
  harness_wakes: boolean;
  ended_at: Date;
  hops: number;
}

/** What deliver() did. */
export interface Delivery {
  /** A turn of its own was queued (start it). */
  readonly turn?: TurnRow;
  /** A steer of the running turn was stored (send it). */
  readonly steerId?: string;
  /** Notes Claude took care of itself, or that were cancelled with their thread. */
  readonly settled: number;
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError>;

/** How much stored output a read looks at (the tail of a large blob). */
const OUTPUT_WINDOW_BYTES = 256 * 1024;

export class BackgroundTaskStore extends Context.Service<
  BackgroundTaskStore,
  {
    list(threadId: string, filter: "all" | "running" | "finished", limit: number): Fx<BackgroundTaskView[]>;
    /** One task by item id or the harness's task id, with the last `outputLines` lines of its output. */
    get(threadId: string, taskId: string, outputLines: number): Fx<BackgroundTaskDetail | undefined>;
    /** item_id and whether it runs, by item id or the harness's task id. */
    find(threadId: string, taskId: string): Fx<{ itemId: string; running: boolean } | undefined>;
    /** Threads with notes deliver() may move now (waiting to wake, or a turn runs that they can join). */
    pendingThreads(): Fx<string[]>;
    deliver(threadId: string, options: { graceMs: number; now?: Date }): Fx<Delivery>;
    /** The agent stops a task itself (stop_background_task): its end needs no note. */
    stoppedByAgent(threadId: string, itemId: string): Fx<void>;
    /**
     * A note steer that did not join its turn: its notes wait again (no turn of its own from the steer; deliver()
     * decides). Returns false when the steer is not a note's.
     */
    release(steerId: string, reason: string): Fx<boolean>;
  }
>()("open-agents/gateway/BackgroundTaskStore") {
  static readonly layer = Layer.effect(
    BackgroundTaskStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const taskOf = (row: TaskRow): BackgroundTask | undefined => {
        const item = fromJson(ItemSchema, row.content);
        return item.content.case === "backgroundTask" ? item.content.value : undefined;
      };

      /** The whole output, or the tail of its blob when it was moved there. */
      const outputOf = (task: BackgroundTask) =>
        Effect.gen(function* () {
          if (task.output || !task.outputBlob?.sha256) return task.output;
          const rows = yield* sql<{ tail: Uint8Array | null }>`
            SELECT substring(data FROM greatest(1, octet_length(data) - ${OUTPUT_WINDOW_BYTES - 1})) AS tail
              FROM blobs WHERE sha256 = ${task.outputBlob.sha256}`;
          const tail = rows[0]?.tail;
          return tail ? new TextDecoder("utf-8", { fatal: false }).decode(tail) : "";
        });

      const view = (row: TaskRow): BackgroundTaskView | undefined => {
        const task = taskOf(row);
        if (!task) return undefined;
        const status = backgroundOutcome(row.status);
        const started = time(task.startedAt);
        const ended = time(task.endedAt);
        const span = started && (ended ?? (status === "running" ? new Date() : undefined));
        return {
          task_id: row.item_id,
          provider_task_id: task.taskId,
          title: backgroundTitle(task, row.item_id),
          command: task.command,
          kind: KINDS[task.kind] ?? "task",
          status,
          reason: backgroundEndReason(status, task.stopReason, task.exitCode),
          ...(task.stopReason && { stop_reason: task.stopReason }),
          ...(task.exitCode !== undefined && { exit_code: task.exitCode }),
          ...(started && { started_at: started.toISOString() }),
          ...(ended && { ended_at: ended.toISOString() }),
          ...(started && span && { duration: formatDuration(span.getTime() - started.getTime()), duration_seconds: Math.round((span.getTime() - started.getTime()) / 1000) }),
          ...(row.turn_id && { started_in_turn_id: row.turn_id }),
          ...(row.turn_ordinal !== null && { started_in_turn: row.turn_ordinal }),
        };
      };

      const byTask = (threadId: string, taskId: string) => sql<TaskRow>`
        SELECT i.item_id, i.turn_id, i.status, i.content, u.ordinal AS turn_ordinal
          FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
         WHERE i.thread_id = ${threadId}::uuid AND i.type = 'background_task'
           AND (i.item_id = ${taskId} OR i.content->'backgroundTask'->>'taskId' = ${taskId} OR i.item_id = ${`bg:${taskId}`})
         ORDER BY (i.item_id = ${taskId}) DESC, i.first_seq DESC LIMIT 1`;

      /** The note's view of its task (for the text). */
      const ended = (row: NoteRow) =>
        Effect.gen(function* () {
          const task = taskOf(row);
          if (!task) return undefined;
          const end: BackgroundTaskEnd = {
            id: row.item_id,
            title: backgroundTitle(task, row.item_id),
            command: task.command,
            outcome: backgroundOutcome(row.status),
            stopReason: task.stopReason,
            exitCode: task.exitCode,
            startedAt: time(task.startedAt),
            endedAt: time(task.endedAt) ?? new Date(row.ended_at),
            output: yield* outputOf(task),
          };
          return end;
        });

      const store: BackgroundTaskStore["Service"] = {
        list: (threadId, filter, limit) =>
          sql<TaskRow>`
            SELECT i.item_id, i.turn_id, i.status, i.content, u.ordinal AS turn_ordinal
              FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
             WHERE i.thread_id = ${threadId}::uuid AND i.type = 'background_task'
               AND (${filter} = 'all' OR (${filter} = 'running') = (i.status = 'in_progress'))
             ORDER BY i.first_seq DESC LIMIT ${limit}`.pipe(Effect.map((rows) => rows.flatMap((row) => view(row) ?? []))),

        get: (threadId, taskId, outputLines) =>
          Effect.gen(function* () {
            const row = (yield* byTask(threadId, taskId))[0];
            const task = row && taskOf(row);
            const base = row && view(row);
            if (!task || !base) return undefined;
            const output = yield* outputOf(task);
            const tail = outputLines > 0 ? outputTail(output, outputLines, 64_000) : { text: "", truncated: output.length > 0 };
            return { ...base, output: tail.text, output_truncated: tail.truncated };
          }),

        find: (threadId, taskId) =>
          byTask(threadId, taskId).pipe(Effect.map((rows) => (rows[0] ? { itemId: rows[0].item_id, running: rows[0].status === "in_progress" } : undefined))),

        pendingThreads: () =>
          sql<{ thread_id: string }>`
            SELECT DISTINCT n.thread_id FROM background_task_notes n
             WHERE n.status = 'waiting'
               AND (n.wake OR EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = n.thread_id AND r.status = 'running'))`.pipe(
            Effect.map((rows) => rows.map((r) => r.thread_id)),
          ),

        deliver: (threadId, { graceMs, now = new Date() }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              // Lifecycle changes take the thread lock first, then settle their pending deliveries.
              const thread = (yield* sql<{ closed: boolean; runtime: string }>`
                SELECT (archived_at IS NOT NULL OR deleted_at IS NOT NULL) AS closed, runtime FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`)[0];
              const notes = yield* sql<NoteRow>`
                SELECT n.item_id, n.wake, n.harness_wakes, n.ended_at, n.hops, i.turn_id, i.status, i.content, NULL::integer AS turn_ordinal
                  FROM background_task_notes n JOIN thread_items i ON i.thread_id = n.thread_id AND i.item_id = n.item_id
                 WHERE n.thread_id = ${threadId}::uuid AND n.status = 'waiting'
                 ORDER BY n.ended_at, n.item_id
                   FOR UPDATE OF n SKIP LOCKED`;
              if (notes.length === 0) return { settled: 0 };
              const settle = (itemIds: string[], status: "harness" | "cancelled", reason: string) =>
                itemIds.length === 0
                  ? Effect.void
                  : sql`UPDATE background_task_notes SET status = ${status}, reason = ${reason}, updated_at = now()
                         WHERE thread_id = ${threadId}::uuid AND item_id = ANY(${itemIds}::text[])`;
              if (!thread || thread.closed) {
                yield* settle(notes.map((n) => n.item_id), "cancelled", "the thread is archived or deleted");
                return { settled: notes.length };
              }
              const running = (yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${threadId}::uuid AND status = 'running' LIMIT 1`)[0];
              const harness: string[] = [];
              const ready: NoteRow[] = [];
              for (const note of notes) {
                if (note.harness_wakes) {
                  // Claude tells the model about a task it saw complete: in the turn that ran when it ended, else in the
                  // turn it starts for it (or the next one of the same process). A turn that was over by then does not count.
                  const endedAt = new Date(note.ended_at);
                  const woke = yield* sql<{ id: string }>`
                    SELECT id FROM turns
                     WHERE thread_id = ${threadId}::uuid AND started_at IS NOT NULL
                       AND (completed_at IS NULL OR completed_at >= ${endedAt})
                       AND started_at <= ${new Date(endedAt.getTime() + graceMs)}
                     LIMIT 1`;
                  if (woke[0]) {
                    harness.push(note.item_id);
                    continue;
                  }
                  if (now.getTime() < endedAt.getTime() + graceMs) continue;
                }
                if (running || note.wake) ready.push(note);
              }
              yield* settle(harness, "harness", "the harness started a turn for it itself");
              if (ready.length === 0) return { settled: harness.length };
              const tasks = (yield* Effect.forEach(ready, ended)).filter((t): t is BackgroundTaskEnd => t !== undefined);
              const note = backgroundTaskNote(tasks, { tools: thread.runtime === "worker" });
              const input = JSON.stringify({ text: note, note, message: "" });
              const ids = ready.map((n) => n.item_id);
              const hops = Math.min(16, Math.max(...ready.map((n) => n.hops)));
              if (running) {
                const steerId = Bun.randomUUIDv7();
                yield* sql`
                  INSERT INTO turn_steers (id, thread_id, turn_id, input, hops, background_note)
                  VALUES (${steerId}::uuid, ${threadId}::uuid, ${running.id}::uuid, ${input}::jsonb, ${hops}, true)`;
                yield* sql`
                  UPDATE background_task_notes SET status = 'steering', steer_id = ${steerId}::uuid, updated_at = now()
                   WHERE thread_id = ${threadId}::uuid AND item_id = ANY(${ids}::text[])`;
                return { steerId, settled: harness.length };
              }
              const turn = (yield* sql<TurnRow>`
                INSERT INTO turns (id, thread_id, ordinal, trigger, hops, input)
                SELECT ${Bun.randomUUIDv7()}::uuid, ${threadId}::uuid, coalesce(max(ordinal), 0) + 1, 'background_task', ${hops}, ${input}::jsonb
                  FROM turns WHERE thread_id = ${threadId}::uuid
                RETURNING *`)[0]!;
              yield* sql`
                UPDATE background_task_notes SET status = 'delivered', turn_id = ${turn.id}::uuid, updated_at = now()
                 WHERE thread_id = ${threadId}::uuid AND item_id = ANY(${ids}::text[])`;
              return { turn, settled: harness.length };
            }),
          ),

        stoppedByAgent: (threadId, itemId) =>
          sql`
            INSERT INTO background_task_notes (thread_id, item_id, status, wake, ended_at, hops, reason)
            VALUES (${threadId}::uuid, ${itemId}, 'delivered', false, now(), 1, 'its agent stopped it (stop_background_task)')
            ON CONFLICT (thread_id, item_id) DO NOTHING`.pipe(Effect.asVoid),

        release: (steerId, reason) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const steer = yield* sql<{ id: string }>`
                UPDATE turn_steers SET status = 'failed', reason = ${reason}, updated_at = now()
                 WHERE id = ${steerId}::uuid AND background_note AND status IN ('pending', 'accepted', 'dropped')
                RETURNING id`;
              if (!steer[0]) return (yield* sql`SELECT 1 FROM turn_steers WHERE id = ${steerId}::uuid AND background_note`).length > 0;
              yield* sql`
                UPDATE background_task_notes SET status = 'waiting', steer_id = NULL, updated_at = now()
                 WHERE steer_id = ${steerId}::uuid AND status = 'steering'`;
              return true;
            }),
          ),
      };
      return BackgroundTaskStore.of(store);
    }),
  );
}

const KINDS: Readonly<Record<number, string>> = { 1: "shell", 2: "agent", 3: "workflow", 4: "process" };

function time(timestamp: Timestamp | undefined): Date | undefined {
  return timestamp ? timestampDate(timestamp) : undefined;
}
