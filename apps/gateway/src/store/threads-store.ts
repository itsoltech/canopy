import { create } from "@bufbuild/protobuf";
import { ThreadSpecSchema, ui, type ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, one, type Fx } from "./errors.ts";
import { archivedPage } from "./archived-pagination.ts";
import { providerOf } from "./instance-config.ts";
import type { ThreadRow } from "./rows.ts";
import { threadSelect } from "./thread-select.ts";
import { permissionModeOf } from "./ui-mappers.ts";

export interface ThreadStore {
  /** `id`: a thread moved here from a linked computer keeps its id (docs/linked-computers.md, stage 8). */
  createThread(ownerUserId: string, request: ui.CreateThreadRequest, id?: string): Fx<ThreadRow>;
  thread(threadId: string, includeDeleted?: boolean): Fx<ThreadRow>;
  /** The owner saw the thread up to `upToSeq` (capped at its last event; the marker only grows). False when nothing changed. */
  markThreadSeen(ownerUserId: string, threadId: string, upToSeq: bigint): Fx<boolean>;
  /** Threads of a project, or of every project the user owns when projectId is empty. */
  listThreads(
    ownerUserId: string,
    projectId: string,
    includeArchived?: boolean,
    sidebarOnly?: boolean,
  ): Fx<ReadonlyArray<ThreadRow>>;
  listArchivedThreads(
    ownerUserId: string,
    request: ui.ListArchivedThreadsRequest,
  ): Fx<{ threads: ThreadRow[]; sideThreads: ThreadRow[]; totalCount: number; nextPageToken: string }>;
  threadSpec(row: ThreadRow): ThreadSpec;
  setThreadStatus(threadId: string, status: string, detail: string | null): Fx<void>;
  /** The thread's default model, effort and permission mode (unset = unchanged). */
  updateThreadSettings(
    threadId: string,
    settings: { model?: string; effort?: string; permissionMode?: string },
  ): Fx<ThreadRow>;
  renameThread(threadId: string, title: string): Fx<ThreadRow>;
  beginTitle(threadId: string, automatic: boolean, context?: string, provisional?: string): Fx<ThreadRow | undefined>;
  finishTitle(threadId: string, revision: bigint, title: string): Fx<boolean>;
}

const archivedThreads = (sql: SqlClient.SqlClient, ownerUserId: string, request: ui.ListArchivedThreadsRequest) =>
  Effect.gen(function* () {
    const page = yield* Effect.try({
      try: () => archivedPage(ownerUserId, request),
      catch: (cause) => new Invalid(cause instanceof Error ? cause.message : String(cause)),
    });

    const where = `WHERE t.owner_user_id = $1::uuid AND t.deleted_at IS NULL AND t.archived_at IS NOT NULL
          AND (cardinality($2::uuid[]) = 0 OR t.project_id = ANY($2::uuid[]))
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL
            AND ($3 = '' OR strpos(lower(t.title), $3) > 0 OR strpos(lower(p.name), $3) > 0
              OR EXISTS (SELECT 1 FROM threads child WHERE child.parent_thread_id = t.id AND child.deleted_at IS NULL
                AND child.owner_user_id = t.owner_user_id AND strpos(lower(child.title), $3) > 0)))
          AND NOT (t.kind = 'side' AND EXISTS (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id
            AND parent.owner_user_id = t.owner_user_id AND parent.deleted_at IS NULL))`;

    const params = [ownerUserId, page.projects, page.query];

    const totalCount = (yield* sql.unsafe<{ count: number }>(
      `SELECT count(*)::int AS count FROM threads t ${where}`,
      params,
    ))[0]!.count;

    if (request.countOnly) return { threads: [], sideThreads: [], totalCount, nextPageToken: "" };

    const rows = yield* sql.unsafe<ThreadRow & { archive_cursor: string }>(
      threadSelect(
        `${where}
          AND ($4::timestamptz IS NULL OR (t.archived_at, t.id) < ($4::timestamptz, $5::uuid))
          ORDER BY t.archived_at DESC, t.id DESC LIMIT $6`,
        `to_char(t.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archive_cursor,`,
      ),
      [...params, page.cursor?.at ?? null, page.cursor?.id ?? null, page.size + 1],
    );

    const threads = rows.slice(0, page.size);
    const last = threads.at(-1);

    const sideThreads = threads.length
      ? yield* sql.unsafe<ThreadRow>(
          threadSelect(`WHERE t.parent_thread_id = ANY($1::uuid[])
          AND t.owner_user_id = $2::uuid AND t.deleted_at IS NULL ORDER BY t.created_at`),
          [threads.map((t) => t.id), ownerUserId],
        )
      : [];

    return {
      threads,
      sideThreads: [...sideThreads],
      totalCount,
      nextPageToken: rows.length > page.size && last ? page.token(last.archive_cursor, last.id) : "",
    };
  });

export function threadStore(sql: SqlClient.SqlClient): Omit<ThreadStore, "createThread"> {
  const store: Omit<ThreadStore, "createThread"> = {
    thread: (threadId, includeDeleted = false) =>
      sql
        .unsafe<ThreadRow>(threadSelect("WHERE t.id = $1::uuid AND (t.deleted_at IS NULL OR $2::boolean)"), [
          threadId,
          includeDeleted,
        ])
        .pipe(Effect.flatMap((rows) => one(rows, "thread"))),

    markThreadSeen: (ownerUserId, threadId, upToSeq) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ seen_seq: string }>`
                INSERT INTO thread_reads (user_id, thread_id, seen_seq)
                SELECT t.owner_user_id, t.id, least(${upToSeq.toString()}::bigint, t.last_seq) FROM threads t
                 WHERE t.id = ${threadId}::uuid AND t.owner_user_id = ${ownerUserId}::uuid AND t.deleted_at IS NULL
                ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = greatest(thread_reads.seen_seq, EXCLUDED.seen_seq),
                  marked_unread = false, seen_at = now()
                 WHERE thread_reads.seen_seq < EXCLUDED.seen_seq OR thread_reads.marked_unread
                RETURNING seen_seq`;

        if (rows.length > 0) return true;
        yield* one(
          yield* sql<{
            id: string;
          }>`SELECT id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid AND deleted_at IS NULL`,
          "thread",
        );

        return false;
      }),

    listThreads: (ownerUserId, projectId, includeArchived = false, sidebarOnly = false) =>
      sql.unsafe<ThreadRow>(
        threadSelect(`WHERE t.owner_user_id = $1::uuid AND ($2::uuid IS NULL OR t.project_id = $2::uuid)
              AND t.deleted_at IS NULL AND (CASE WHEN $4::boolean THEN ((t.archived_at IS NULL AND NOT EXISTS
                (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id AND parent.archived_at IS NOT NULL)) OR
                (t.kind = 'side' AND EXISTS (SELECT 1 FROM threads parent WHERE parent.id = t.parent_thread_id
                  AND parent.owner_user_id = t.owner_user_id AND parent.archived_at IS NULL AND parent.deleted_at IS NULL)))
                ELSE ($3::boolean OR t.archived_at IS NULL) END)
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL) ORDER BY t.created_at`),
        [ownerUserId, projectId || null, includeArchived, sidebarOnly],
      ),

    listArchivedThreads: (ownerUserId, request) => archivedThreads(sql, ownerUserId, request),

    threadSpec: (row) =>
      create(ThreadSpecSchema, {
        threadId: row.id,
        provider: providerOf(row.provider),
        providerProfileId: row.provider_profile_id ?? "",
        cwd: row.cwd ?? "",
        scratch: row.project_kind === "scratch",
        model: row.settings.model ?? "",
        // A thread moved from a linked computer continues with its handoff note (stage 8).
        instructions: [
          row.settings.instructions,
          row.settings.handoff,
          row.origin === "agent" && (row.depth > 0 || row.remote_parent_ref)
            ? "Your final message is reported to your parent automatically. Use send_message to your parent only for updates it must act on mid-task; use ask_user for questions."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
        permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
        // Agent bus tools for every worker thread: Codex dynamicTools, Claude MCP (docs/agent-bus.md).
        enableAgentBus: row.runtime === "worker",
        providerThreadId: row.provider_thread_id ?? "",
        depth: row.remote_parent_ref ? 1 : row.depth,
      }),

    setThreadStatus: (threadId, status, detail) =>
      sql`UPDATE threads SET status = ${status}, status_detail = ${detail} WHERE id = ${threadId}::uuid AND deleted_at IS NULL AND archived_at IS NULL`.pipe(
        Effect.asVoid,
      ),

    updateThreadSettings: (threadId, settings) =>
      sql`
              UPDATE threads SET settings = settings || ${JSON.stringify(settings)}::jsonb WHERE id = ${threadId}::uuid AND archived_at IS NULL`.pipe(
        Effect.andThen(store.thread(threadId)),
      ),

    renameThread: (threadId, title) =>
      sql`UPDATE threads SET title = ${title}, title_source = 'user', title_revision = title_revision + 1
                 WHERE id = ${threadId}::uuid AND archived_at IS NULL`.pipe(Effect.andThen(store.thread(threadId))),

    beginTitle: (threadId, automatic, context, provisional) =>
      sql<ThreadRow>`UPDATE threads SET title_revision = title_revision + 1, title_requested = true,
                  title_context = CASE WHEN title_context = '' THEN ${context ?? ""} ELSE title_context END,
                  title = CASE WHEN ${automatic} THEN ${provisional ?? "New thread"} ELSE title END
                WHERE id = ${threadId}::uuid AND archived_at IS NULL
                  AND (NOT ${automatic} OR (title_source = 'provisional' AND NOT title_requested))
                RETURNING *`.pipe(Effect.map((rows) => rows[0])),

    finishTitle: (threadId, revision, title) =>
      sql`UPDATE threads SET title = ${title}, title_source = 'generated'
                 WHERE id = ${threadId}::uuid AND title_revision = ${revision} AND archived_at IS NULL
                 RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
  };

  return store;
}
