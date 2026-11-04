import { type JsonValue } from "@bufbuild/protobuf";
import { agentKey, fuzzyRank, type AgentBusArgs, type SpawnTarget } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { type ThreadRow, type TurnRow } from "./store.ts";
import { finishedTurn } from "./notification-observation.ts";

import {
  busPermissionMode,
  inputJson,
  truncateJson,
  type CallSource,
  type Fx,
  type ThreadSummary,
  type TurnInput,
} from "./agent-bus-types.ts";
import { callerMode, insertCall, queueTurn, summary, thread } from "./agent-bus-queries.ts";

export interface BusThreadStore {
  spawn(input: {
    source: CallSource;
    caller: ThreadRow;
    args: AgentBusArgs["spawn_thread"];
    /** Provider instance, model and effort of the new thread (resolveSpawnTarget). */
    target: SpawnTarget;
    hops: number;
  }): Fx<{ thread: ThreadRow; turn: TurnRow; result: JsonValue }>;
  /**
   * Queues the message as the next turn, or, with delivery = steer while the target runs a turn, stores it as a
   * steer of that turn (turn_steers; the caller hears back when the turn it joined finishes).
   */
  send(input: {
    source: CallSource;
    caller: ThreadRow;
    args: AgentBusArgs["send_message"];
    hops: number;
  }): Fx<
    { turn: TurnRow; result: JsonValue; steerId?: undefined } | { turn?: undefined; steerId: string; result: JsonValue }
  >;
  summary(threadId: string): Fx<ThreadSummary>;
  /**
   * Threads of the caller's tree: its children, or the whole tree (without the caller); or (all) any thread of the
   * caller's owner, by title (fuzzy) when `query` is given, the most recent activity first.
   */
  listThreads(
    caller: ThreadRow,
    scope: "children" | "tree" | "all",
    options?: { query?: string; limit?: number },
  ): Fx<ThreadSummary[]>;
  readThread(input: {
    threadId: string;
    afterSeq: number;
    limit: number;
    view: "messages" | "items";
  }): Fx<{ result: { entries: JsonValue[]; nextSeq: number }; observedTurnIds: string[] }>;
  /** The thread could not be created: its queued turns fail (so callers waiting on them hear back). */
  failQueuedTurns(threadId: string, reason: string): Fx<ReadonlyArray<string>>;
  /** Archives a thread, cancels its queued turns, its schedules and pending notifications about it. */
  close(threadId: string, callerId?: string): Fx<void>;
}

const spawn = (
  sql: SqlClient.SqlClient,
  { source, caller, args, target, hops }: Parameters<BusThreadStore["spawn"]>[0],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const notify = args.notify ?? true;
      yield* insertCall(sql, { source, tool: "spawn_thread", args, status: "completed", hops, notify });
      const id = Bun.randomUUIDv7();

      // Same place as the caller (threads_before_insert enforces the placement), on the provider instance, model
      // and effort the gateway resolved (the caller's unless the call chose others from list_agents); its
      // permissions unless the call narrows them (authorizeBusCall: never broader). A role adds to the caller's
      // instructions.
      const settings: ThreadRow["settings"] = {
        ...caller.settings,
        // The calling turn's mode, not the thread's default (never broader than the caller right now).
        permissionMode: (yield* callerMode(sql, source, caller)).toUpperCase(),
        model: target.model,
        effort: target.effort,
        ...(args.permission_mode !== undefined && { permissionMode: args.permission_mode.toUpperCase() }),
        ...(args.instructions !== undefined && {
          instructions: [caller.settings.instructions, args.instructions].filter(Boolean).join("\n\n"),
        }),
      };

      yield* sql`
            INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, origin, spawned_by_call_id,
                                 interaction_route, runtime, provider, provider_profile_id, worker_id, workspace_id, cwd,
                                 fork_source_thread_id, settings, status, title, worktree_id)
            VALUES (${id}::uuid, ${caller.project_id}::uuid, ${caller.owner_user_id}::uuid, 'side', ${caller.id}::uuid,
                    ${caller.root_thread_id}::uuid, ${caller.depth + 1}, 'agent', ${source.callId}::uuid,
                    ${args.interactions ?? "parent"}, 'worker', ${target.harness},
                    ${target.instance && target.instance !== "native" ? target.instance : null},
                    ${caller.worker_id}::uuid, ${caller.workspace_id}::uuid, ${caller.cwd},
                    ${args.fork ? caller.id : null}::uuid, ${JSON.stringify(settings)}::jsonb, 'creating', ${args.title.trim()},
                    ${caller.worktree_id ?? null}::uuid)`;

      const input: TurnInput = {
        note:
          `[canopy] Task from the thread "${caller.title}" (thread_id: ${caller.id}). ` +
          "End your turn with a final message that reports your result; it is delivered to that thread.",
        message: args.prompt,
      };

      const turn = yield* queueTurn(sql, {
        threadId: id,
        input,
        trigger: "agent_bus",
        callId: source.callId,
        hops,
      });

      // Stored as returned: a re-sent call gets exactly this.
      const result = {
        thread_id: id,
        turn_id: turn.id,
        provider: agentKey(target),
        model: settings.model ?? "",
        effort: settings.effort ?? "",
        permission_mode: busPermissionMode(settings.permissionMode),
        note: notify
          ? "The side thread is working. You will get a message in this thread when it finishes its turn; continue meanwhile or call wait_threads."
          : "The side thread is working. Follow it with wait_threads or get_thread.",
      };

      yield* sql`
            UPDATE agent_bus_calls SET target_thread_id = ${id}::uuid, target_turn_id = ${turn.id}::uuid, result = ${JSON.stringify(result)}::jsonb
             WHERE id = ${source.callId}::uuid`;

      return { thread: yield* thread(sql, id), turn, result };
    }),
  );

const send = (sql: SqlClient.SqlClient, { source, caller, args, hops }: Parameters<BusThreadStore["send"]>[0]) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const notify = args.notify ?? true;
      yield* insertCall(sql, { source, tool: "send_message", args, status: "completed", hops, notify });
      // From another tree (any thread of the same owner, like the user writing there): the target learns who wrote.
      const target = yield* thread(sql, args.thread_id);
      const outside = target.root_thread_id !== caller.root_thread_id;

      const input: TurnInput = {
        note:
          `[canopy] Message from the thread "${caller.title}" (thread_id: ${caller.id})` +
          (outside
            ? `, an agent outside your thread tree${notify ? "; your final message of this turn is reported back to it" : ""}`
            : "") +
          ":",
        message: args.prompt,
      };

      const running =
        args.delivery === "steer"
          ? (yield* sql<{
              id: string;
            }>`SELECT id FROM turns WHERE thread_id = ${args.thread_id}::uuid AND status = 'running' LIMIT 1`)[0]
          : undefined;

      if (running) {
        // The call reports the turn once the message is in it (Ingest binds target_turn_id), or the turn it
        // falls back to.
        const steerId = Bun.randomUUIDv7();
        yield* sql`
              INSERT INTO turn_steers (id, thread_id, turn_id, input, agent_call_id, hops)
              VALUES (${steerId}::uuid, ${args.thread_id}::uuid, ${running.id}::uuid, ${inputJson(input)}::jsonb, ${source.callId}::uuid, ${hops})`;

        const result = {
          thread_id: args.thread_id,
          turn_id: running.id,
          delivery: "steer",
          note: "The message joins the turn that is running now. If that turn ends first, it runs as the next turn instead.",
        };

        yield* sql`
              UPDATE agent_bus_calls SET target_thread_id = ${args.thread_id}::uuid, result = ${JSON.stringify(result)}::jsonb
               WHERE id = ${source.callId}::uuid`;

        return { steerId, result };
      }

      const turn = yield* queueTurn(sql, {
        threadId: args.thread_id,
        input,
        trigger: "agent_bus",
        callId: source.callId,
        hops,
      });

      const result = {
        thread_id: args.thread_id,
        turn_id: turn.id,
        ...(args.delivery === "steer" && {
          delivery: "queue",
          note: "No turn is running there: the message runs as the next turn.",
        }),
      };

      yield* sql`
            UPDATE agent_bus_calls SET target_thread_id = ${args.thread_id}::uuid, target_turn_id = ${turn.id}::uuid, result = ${JSON.stringify(result)}::jsonb
             WHERE id = ${source.callId}::uuid`;

      return { turn, result };
    }),
  );

export function busThreadStore(sql: SqlClient.SqlClient): BusThreadStore {
  const store: BusThreadStore = {
    spawn: (input) => spawn(sql, input),

    send: (input) => send(sql, input),

    summary: (threadId) => summary(sql, threadId),

    listThreads: (caller, scope, options) =>
      Effect.gen(function* () {
        if (scope === "all") {
          const owned = yield* sql<{ id: string; title: string }>`
                SELECT t.id, t.title FROM threads t
                 WHERE t.owner_user_id = ${caller.owner_user_id}::uuid AND t.id <> ${caller.id}::uuid AND t.archived_at IS NULL AND t.deleted_at IS NULL
                 ORDER BY greatest(t.created_at, (SELECT max(coalesce(u.completed_at, u.started_at, u.queued_at)) FROM turns u WHERE u.thread_id = t.id)) DESC
                 LIMIT 500`;

          const limit = options?.limit ?? 20;
          const query = options?.query?.trim() ?? "";

          const picked = query
            ? fuzzyRank(query, owned, (t) => [t.title || "Untitled"], limit).map((r) => r.item)
            : owned.slice(0, limit);

          return yield* Effect.forEach(picked, (r) => summary(sql, r.id));
        }

        const rows =
          scope === "children"
            ? yield* sql<{
                id: string;
              }>`SELECT id FROM threads WHERE parent_thread_id = ${caller.id}::uuid AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at`
            : yield* sql<{ id: string }>`
                    SELECT id FROM threads WHERE root_thread_id = ${caller.root_thread_id}::uuid AND id <> ${caller.id}::uuid AND archived_at IS NULL AND deleted_at IS NULL
                     ORDER BY depth, created_at`;

        return yield* Effect.forEach(rows, (r) => summary(sql, r.id));
      }),

    readThread: ({ threadId, afterSeq, limit, view }) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          type: string;
          content: Record<string, JsonValue>;
          last_seq: bigint;
          turn_id: string | null;
          turn_status: string | null;
          final: boolean;
        }>`
              SELECT i.type, i.content, i.last_seq, i.turn_id, u.status AS turn_status,
                     i.type = 'agent_message' AND NOT EXISTS (
                       SELECT 1 FROM thread_items later WHERE later.thread_id = i.thread_id AND later.turn_id = i.turn_id
                         AND later.type = 'agent_message' AND later.first_seq > i.first_seq) AS final
                FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
               WHERE i.thread_id = ${threadId}::uuid AND i.last_seq > ${afterSeq}
                 AND (${view} = 'items' OR i.type IN ('user_message', 'agent_message'))
               ORDER BY i.first_seq LIMIT ${limit}`;

        const entries = rows.map((r): JsonValue => {
          const { itemId: _id, status: _status, ...content } = r.content;

          return { seq: Number(r.last_seq), type: r.type, ...truncateJson(content) };
        });

        return {
          result: { entries, nextSeq: rows.length > 0 ? Number(rows[rows.length - 1]!.last_seq) : afterSeq },
          observedTurnIds: rows.flatMap((r) =>
            r.final && r.turn_id && finishedTurn(r.turn_status ?? "") ? [r.turn_id] : [],
          ),
        };
      }),

    failQueuedTurns: (threadId, reason) =>
      sql<{ id: string }>`
            UPDATE turns SET status = 'failed', error = ${reason}, error_source = 'platform', completed_at = now()
             WHERE thread_id = ${threadId}::uuid AND status = 'queued' RETURNING id`.pipe(
        Effect.map((rows) => rows.map((r) => r.id)),
      ),

    close: (threadId, callerId) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE threads SET status = 'archived', archived_at = now(), archived_by = 'agent', archived_by_thread_id = ${callerId ?? null}::uuid
                WHERE id = ${threadId}::uuid AND archived_at IS NULL AND deleted_at IS NULL`;
          yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE thread_id = ${threadId}::uuid AND status = 'queued'`;
          yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled' WHERE target_thread_id = ${threadId}::uuid AND notify_status = 'pending'`;
          yield* sql`
                UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
                 WHERE thread_id = ${threadId}::uuid AND status IN ('active', 'paused')`;
        }),
      ),
  };

  return store;
}
