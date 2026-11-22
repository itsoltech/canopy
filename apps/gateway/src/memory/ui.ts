import { create } from "@bufbuild/protobuf";
import { EmptySchema, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { UiHandlers } from "../api/ui-service.ts";
import type { GatewayCore } from "../core/core.ts";
import { coreState, type CoreRuntime } from "../core/core-context.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import { MemoryConflict, memoryFor, type MemoryNote, type MemoryScope } from "./store.ts";

const scopeOf = {
  project: ui.MemoryNoteScope.PROJECT,
  worker: ui.MemoryNoteScope.WORKER,
  bot: ui.MemoryNoteScope.BOT,
  conversation: ui.MemoryNoteScope.CONVERSATION,
};

function scopeFilter(scope: ui.MemoryNoteScope): MemoryScope["kind"] | undefined {
  switch (scope) {
    case ui.MemoryNoteScope.UNSPECIFIED:
      return undefined;
    case ui.MemoryNoteScope.PROJECT:
      return "project";
    case ui.MemoryNoteScope.WORKER:
      return "worker";
    case ui.MemoryNoteScope.BOT:
      return "bot";
    case ui.MemoryNoteScope.CONVERSATION:
      return "conversation";
    default:
      throw new Invalid("Choose a valid memory scope.");
  }
}

function scopeLabels(runtime: CoreRuntime, ownerId: string, scopes: readonly MemoryScope[]) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projects = new Set<string>();
      const workers = new Set<string>();
      const bots = new Set<string>();
      const conversations = new Set<string>();

      for (const scope of scopes) {
        if ("projectId" in scope) projects.add(scope.projectId);

        if ("workerId" in scope) workers.add(scope.workerId);

        if ("botId" in scope) bots.add(scope.botId);

        if ("conversationId" in scope) conversations.add(scope.conversationId);
      }

      const rows = yield* sql<{ kind: string; id: string; label: string }>`
        SELECT 'project' AS kind,id,name AS label FROM projects
          WHERE id=ANY(${[...projects]}::uuid[]) AND owner_user_id=${ownerId}::uuid
        UNION ALL SELECT 'worker',w.id,w.name FROM workers w
          WHERE w.id=ANY(${[...workers]}::uuid[]) AND (
            w.owner_user_id=${ownerId}::uuid OR (w.owner_user_id IS NULL AND EXISTS (
              SELECT 1 FROM project_workspaces ws JOIN projects p ON p.id=ws.project_id
              WHERE ws.worker_id=w.id AND p.owner_user_id=${ownerId}::uuid
            ))
          )
        UNION ALL SELECT 'bot',id,configuration->>'name' FROM bots
          WHERE id=ANY(${[...bots]}::uuid[]) AND owner_user_id=${ownerId}::uuid
        UNION ALL SELECT 'conversation',c.id,concat_ws(' · ','Slack',c.channel_id,nullif(c.thread_id,'')) FROM bot_channel_conversations c
          JOIN bot_channel_routes r ON r.id=c.route_id
          WHERE c.id=ANY(${[...conversations]}::uuid[]) AND r.owner_user_id=${ownerId}::uuid`;

      return new Map(rows.map(({ kind, id, label }) => [`${kind}/${id}`, label]));
    }),
  );
}

function filterOptions(scopes: readonly MemoryScope[], labels: ReadonlyMap<string, string>) {
  const projects = new Set<string>();
  const workers = new Set<string>();

  for (const scope of scopes) {
    if ("projectId" in scope) projects.add(scope.projectId);

    if ("workerId" in scope) workers.add(scope.workerId);
  }

  const options = (ids: Set<string>, kind: string, label: string) =>
    Array.from(ids, (id) => ({ id, label: labels.get(`${kind}/${id}`) || `${label} ${id.slice(0, 8)}` })).sort(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );

  return { projects: options(projects, "project", "Project"), workers: options(workers, "worker", "Worker") };
}

function uiNote(note: MemoryNote, labels: ReadonlyMap<string, string>): ui.MemoryNote {
  const { scope, source } = note;
  const projectId = "projectId" in scope ? scope.projectId : "";
  const workerId = "workerId" in scope ? scope.workerId : "";
  const botId = "botId" in scope ? scope.botId : "";
  const conversationId = "conversationId" in scope ? scope.conversationId : "";

  const scopeLabel = [
    labels.get(`project/${projectId}`),
    labels.get(`worker/${workerId}`),
    labels.get(`bot/${botId}`),
    labels.get(`conversation/${conversationId}`),
  ]
    .filter(Boolean)
    .join(" · ");

  return create(ui.MemoryNoteSchema, {
    id: note.id,
    scope: scopeOf[scope.kind],
    title: note.title,
    body: note.body,
    aliases: [...note.aliases],
    pinned: note.pinned,
    revision: note.revision,
    projectId,
    workerId,
    botId,
    conversationId,
    ...(source && { sourceKind: source.kind, sourceId: source.id, sourceTurnId: source.turnId }),
    updatedAt: timestampFromDate(note.updatedAt),
    ...(note.createdAt && { createdAt: timestampFromDate(note.createdAt) }),
    scopeLabel,
  });
}

/** SQL errors can include parameters. Keep the raw note out of response diagnostics. */
async function memoryGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    let error: unknown = cause;

    for (let i = 0; i < 5 && error instanceof Error; i++, error = error.cause) {
      if (error instanceof Invalid) throw new ConnectError(error.message, Code.InvalidArgument);

      if (error instanceof NotFound) throw new ConnectError(error.message, Code.NotFound);

      if (error instanceof MemoryConflict) throw new ConnectError(error.message, Code.FailedPrecondition);
    }

    throw new ConnectError("Could not access memory. Try again.", Code.Internal);
  }
}

export function memoryHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "listMemoryNotes" | "updateMemoryNote" | "deleteMemoryNote"> {
  const { runtime, userId } = core[coreState].options;
  const store = memoryFor(runtime);

  return {
    listMemoryNotes: (request) =>
      memoryGuard(async () => {
        const { notes, nextCursor } = await store.list(userId, {
          scope: scopeFilter(request.scope),
          cursor: request.cursor,
          limit: request.limit,
          projectId: request.projectId,
          workerId: request.workerId,
          query: request.query,
        });

        const available = request.includeFilterOptions ? await store.filterScopes(userId) : [];
        const scopes = [...notes.map((note) => note.scope), ...available];
        const labels = scopes.length ? await scopeLabels(runtime, userId, scopes) : new Map<string, string>();

        return create(ui.ListMemoryNotesResponseSchema, {
          notes: notes.map((note) => uiNote(note, labels)),
          nextCursor,
          ...(request.includeFilterOptions && { filterOptions: filterOptions(available, labels) }),
        });
      }),
    updateMemoryNote: (request) =>
      memoryGuard(async () => {
        const { noteId, expectedRevision, title, body, aliases, pinned } = request;
        const note = await store.edit(userId, noteId, { title, body, aliases, pinned }, expectedRevision);

        return uiNote(note, await scopeLabels(runtime, userId, [note.scope]));
      }),
    deleteMemoryNote: (request) =>
      memoryGuard(async () => {
        await store.remove(userId, request.noteId, request.expectedRevision);

        return create(EmptySchema);
      }),
  };
}
