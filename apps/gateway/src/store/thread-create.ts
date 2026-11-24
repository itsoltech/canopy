import { toJson } from "@bufbuild/protobuf";
import { SandboxProfileBindingSchema, ui, type SandboxProfileBinding } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, one } from "./errors.ts";
import { isAbsolutePath, isWithinWorkspace, normalizePath, pathStyle, scratchCwd } from "./paths.ts";
import { harnessOf } from "./instance-config.ts";
import type { ThreadRow, TurnRow } from "./rows.ts";
import { permissionModeName } from "./ui-mappers.ts";
import type { ThreadStore } from "./threads-store.ts";
import type { WorktreeStore } from "./worktrees.ts";
import { automatedPermission } from "./automated-permissions.ts";
import { busPermissionMode } from "./agent-bus-types.ts";
import { DRAFT_SANDBOX_RESELECT, SANDBOX_DERIVATION_UNAVAILABLE, threadSandbox } from "./thread-sandbox.ts";
import type { AutomatedAccess } from "./automated-permissions.ts";

const creationAccess = (
  sql: SqlClient.SqlClient,
  owner: string,
  worker: string,
  request: ui.CreateThreadRequest,
  automated?: AutomatedAccess,
) =>
  automated
    ? automatedPermission(
        sql,
        owner,
        worker,
        busPermissionMode(permissionModeName(request.permissionMode)),
        automated.permissionModeNote,
      )
    : Effect.succeed({ permissionMode: permissionModeName(request.permissionMode) || "ASK" });

/**
 * The turn a fork starts after (CreateThreadRequest.fork_at_turn_id): in the visible history of the thread
 * forked from (its own turns or those it inherits, up to its fork point), ended, and with a fork point at
 * the provider. A turn without one (it ended before the provider started it) cannot be forked at: the
 * adapters would copy the whole history instead.
 */
const forkPoint = (sql: SqlClient.SqlClient, ownerUserId: string, request: ui.CreateThreadRequest) =>
  Effect.gen(function* () {
    const from = request.forkThreadId || request.parentThreadId;

    if (!from) return yield* Effect.fail(new Invalid("fork_at_turn_id needs the thread to fork from (fork_thread_id)"));

    if (request.parentThreadId && !request.fork)
      return yield* Effect.fail(new Invalid("fork_at_turn_id with a parent needs fork"));

    const rows = yield* sql<TurnRow & Pick<ThreadRow, "provider" | "provider_thread_id" | "settings">>`
              SELECT u.*, s.provider, s.provider_thread_id, s.settings FROM turns u
                JOIN thread_fork_chain(${from}::uuid) c ON c.thread_id = u.thread_id
                JOIN threads s ON s.id = u.thread_id
                JOIN threads f ON f.id = ${from}::uuid
               WHERE u.id = ${request.forkAtTurnId}::uuid AND f.owner_user_id = ${ownerUserId}::uuid
                 AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)
                 AND thread_turn_visible_at(u.id,coalesce(c.upto_seq,f.last_seq)) FOR SHARE OF s`;

    const point = rows[0];

    if (!point) return yield* Effect.fail(new Invalid("the turn is not in this thread's history"));

    if (threadSandbox(point)) return yield* Effect.fail(new Invalid(SANDBOX_DERIVATION_UNAVAILABLE));

    if (point.provider === "grok") return yield* Effect.fail(new Invalid("Grok ACP does not support session forks"));

    if (!["completed", "failed", "interrupted"].includes(point.status)) {
      return yield* Effect.fail(
        new Invalid(`turn ${point.ordinal} is ${point.status}: a fork starts after an ended turn`),
      );
    }

    if (!point.provider_turn_ref || !point.provider_thread_id) {
      return yield* Effect.fail(
        new Invalid(
          `turn ${point.ordinal} never reached ${point.provider === "claude" ? "Claude" : "Codex"}, so there is no point to fork at; fork from an earlier turn`,
        ),
      );
    }

    return point;
  });

/** A fork can select an ancestor turn while copying its named source's instructions and placement. */
function creationAudience(
  sql: SqlClient.SqlClient,
  parentId: string,
  sourceId: string | null,
  request: ui.CreateThreadRequest,
  automated?: AutomatedAccess,
) {
  return Effect.gen(function* () {
    const ids = [parentId, sourceId, request.forkAtTurnId && request.forkThreadId].filter((id) => !!id);

    const histories = ids.length
      ? yield* sql<{ memory_audience: string }>`SELECT memory_audience FROM threads WHERE id=ANY(${ids}::uuid[])`
      : [];

    const audience = automated?.memoryAudience ?? histories[0]?.memory_audience ?? "";

    if (histories.some((row) => row.memory_audience !== audience))
      return yield* Effect.fail(new Invalid("Choose a thread from this conversation."));

    return audience;
  });
}

const creationWorkspace = (sql: SqlClient.SqlClient, ownerUserId: string, request: ui.CreateThreadRequest) =>
  Effect.flatMap(
    sql<{
      id: string;
      project_id: string;
      worker_id: string;
      root_path: string;
      os: string;
      project_kind: string;
    }>`
          SELECT pw.id, pw.project_id, pw.worker_id, pw.root_path, w.os, p.kind AS project_kind
            FROM project_workspaces pw JOIN workers w ON w.id = pw.worker_id JOIN projects p ON p.id = pw.project_id
           WHERE pw.id = ${request.workspaceId}::uuid AND pw.project_id = ${request.projectId}::uuid
             AND p.owner_user_id = ${ownerUserId}::uuid AND p.archived_at IS NULL
             AND (w.owner_user_id IS NULL OR w.owner_user_id = ${ownerUserId}::uuid)
             AND w.archived_at IS NULL AND w.revoked_at IS NULL
             AND (pw.archived_at IS NULL OR ${request.parentThreadId !== "" || request.forkAtTurnId !== ""}::boolean)
           FOR SHARE OF p`,
    (rows) => one(rows, "workspace"),
  );

function replayCreation(
  sql: SqlClient.SqlClient,
  ownerUserId: string,
  request: ui.CreateThreadRequest,
  readThread: ThreadStore["thread"],
) {
  return Effect.gen(function* () {
    if (!request.clientRequestId) return;

    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerUserId}:${request.clientRequestId}`}, 9236))`;

    const previous = (yield* sql<{ id: string }>`SELECT id FROM threads
      WHERE owner_user_id=${ownerUserId}::uuid AND creation_request_id=${request.clientRequestId}`)[0];

    if (!previous) return;
    const existing = yield* readThread(previous.id);
    const binding = threadSandbox(existing);

    if (request.sandboxProfileDigest && request.sandboxProfileDigest !== binding?.digest)
      return yield* Effect.fail(new Invalid(DRAFT_SANDBOX_RESELECT));

    if (request.sandboxProfileId && request.sandboxProfileId !== binding?.profile?.id)
      return yield* Effect.fail(
        new Invalid("This request already created a thread with a different sandbox selection."),
      );

    return existing;
  });
}

/** Pin inherited placement and policy while the fork or side thread is being created. */
function lockCreationSources(sql: SqlClient.SqlClient, ownerUserId: string, request: ui.CreateThreadRequest) {
  return Effect.gen(function* () {
    const sourceIds = [request.parentThreadId, request.forkThreadId].filter(Boolean);

    if (!sourceIds.length) return;

    const sourcePolicies = yield* sql<Pick<ThreadRow, "settings" | "cwd" | "worktree_id" | "id">>`
      SELECT settings,cwd,worktree_id,id FROM threads WHERE id=ANY(${sourceIds}::uuid[]) AND owner_user_id=${ownerUserId}::uuid
      ORDER BY id FOR SHARE`;

    if (sourcePolicies.some(threadSandbox)) return yield* Effect.fail(new Invalid(SANDBOX_DERIVATION_UNAVAILABLE));

    return !request.parentThreadId && request.forkAtTurnId
      ? sourcePolicies.find((row) => row.id === request.forkThreadId)
      : undefined;
  });
}

export function threadCreation(
  sql: SqlClient.SqlClient,
  self: () => Pick<ThreadStore, "thread"> & Pick<WorktreeStore, "ownWorktree">,
): Pick<ThreadStore, "createThread"> {
  return {
    createThread: (
      ownerUserId,
      request,
      movedId,
      automated,
      handoff,
      preparationFingerprint,
      humanInitialInput,
      sandboxProfile,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* replayCreation(sql, ownerUserId, request, self().thread);

          if (previous) return previous;
          const workspace = yield* creationWorkspace(sql, ownerUserId, request);
          const provider = harnessOf(request.provider);

          if (!provider) return yield* Effect.fail(new Invalid("unknown provider"));
          const id = movedId ?? Bun.randomUUIDv7();
          const forkPlacement = yield* lockCreationSources(sql, ownerUserId, request);

          if (request.sandboxProfileDigest && request.sandboxProfileDigest !== sandboxProfile?.digest)
            return yield* Effect.fail(new Invalid(DRAFT_SANDBOX_RESELECT));

          if (request.sandboxProfileId && (!sandboxProfile || request.sandboxProfileId !== sandboxProfile.profile?.id))
            return yield* Effect.fail(new Invalid("Choose an available sandbox profile."));

          const parent = request.parentThreadId ? yield* self().thread(request.parentThreadId) : undefined;

          if (parent && parent.owner_user_id !== ownerUserId)
            return yield* Effect.fail(new Invalid("parent thread not found"));

          if (parent?.provider === "grok" && request.fork)
            return yield* Effect.fail(new Invalid("Grok ACP does not support session forks"));

          if (parent?.archived_at) return yield* Effect.fail(new Invalid("parent thread is archived"));

          if (parent && parent.workspace_id !== workspace.id) {
            return yield* Effect.fail(new Invalid("a side thread runs in its parent's workspace"));
          }

          if (parent && request.fork && parent.provider !== provider) {
            return yield* Effect.fail(new Invalid(`a fork keeps its parent's provider (${parent.provider})`));
          }

          // Fork source and point: the parent's latest completed turn (pinned by the database), or a chosen turn.
          let forkSource = parent && request.fork ? parent.id : null;
          let forkAfterTurn: string | null = null;

          if (request.forkAtTurnId) {
            const point = yield* forkPoint(sql, ownerUserId, request);

            if (point.provider !== provider)
              return yield* Effect.fail(new Invalid(`a fork keeps its source's provider (${point.provider})`));

            if (parent && point.thread_id !== parent.id)
              return yield* Effect.fail(new Invalid("a side thread forks at a turn of its parent"));
            forkSource = point.thread_id;
            forkAfterTurn = point.id;
          }

          // A thread may start below the workspace root, never outside it (paths follow the worker's OS).
          const style = pathStyle(workspace.os, workspace.root_path);

          const inherited =
            (parent && (!request.workspaceMode || request.workspaceMode === ui.WorkspaceMode.INHERIT_PARENT)
              ? parent
              : undefined) ??
            (workspace.project_kind === "scratch" && forkSource ? yield* self().thread(forkSource) : undefined);

          if (workspace.project_kind === "scratch" && !inherited && request.cwd) {
            return yield* Effect.fail(new Invalid("a new no-project thread gets its own scratch directory"));
          }

          // A git worktree (docs/worktrees.md): the core made it (or the user chose one) before; it is the owner's,
          // in this project and workspace. Side threads stay in their parent's directory and worktree.
          const worktreeMode = [ui.WorkspaceMode.NEW_WORKTREE, ui.WorkspaceMode.EXISTING_WORKTREE].includes(
            request.workspaceMode,
          );

          if (worktreeMode && workspace.project_kind === "scratch")
            return yield* Effect.fail(new Invalid("a no-project thread has no repository for a worktree"));

          if (worktreeMode && !request.worktreeId && !preparationFingerprint)
            return yield* Effect.fail(new Invalid("choose a worktree for the thread"));

          const worktree =
            worktreeMode && !preparationFingerprint
              ? yield* self().ownWorktree(ownerUserId, request.worktreeId, workspace.project_id, workspace.id)
              : undefined;

          const requested = !worktree && !inherited && request.cwd ? normalizePath(request.cwd, style) : undefined;

          if (
            (workspace.project_kind !== "scratch" || !inherited) &&
            requested &&
            (!isAbsolutePath(request.cwd, style) ||
              !isWithinWorkspace(requested, workspace.root_path, style, workspace.os))
          ) {
            return yield* Effect.fail(new Invalid(`${request.cwd} is outside the workspace ${workspace.root_path}`));
          }

          const cwd =
            worktree?.path ??
            inherited?.cwd ??
            (workspace.project_kind === "scratch"
              ? scratchCwd(workspace.root_path, id, style)
              : (requested ?? workspace.root_path));

          const worktreeId = worktree?.id ?? inherited?.worktree_id ?? null;

          if (forkPlacement && (forkPlacement.cwd !== cwd || forkPlacement.worktree_id !== worktreeId))
            return yield* Effect.fail(
              new Invalid("The source thread switched worktrees. Retry the fork in its current directory."),
            );

          const access = yield* creationAccess(sql, ownerUserId, workspace.worker_id, request, automated);

          const audience = yield* creationAudience(sql, request.parentThreadId, forkSource, request, automated);

          if (sandboxProfile && access.permissionMode !== "FULL_AUTO")
            return yield* Effect.fail(new Invalid("Sandbox profiles require Full auto."));

          const settings = creationSettings(request, access, handoff, sandboxProfile);

          yield* sql`
                  INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, runtime, provider,
                                       provider_profile_id, worker_id, workspace_id, cwd, fork_source_thread_id, fork_after_turn_id, settings, status, title, title_source,
                                       worktree_id, creation_request_id, preparation_fingerprint, memory_audience)
                  VALUES (${id}::uuid, ${workspace.project_id}::uuid, ${ownerUserId}::uuid, ${parent ? "side" : "main"},
                          ${parent?.id ?? null}::uuid, ${parent?.root_thread_id ?? id}::uuid, ${parent ? parent.depth + 1 : 0}, 'worker', ${provider},
                          ${request.providerProfileId && request.providerProfileId !== "native" ? request.providerProfileId : null}, ${workspace.worker_id}::uuid, ${workspace.id}::uuid, ${preparationFingerprint ? null : cwd},
                          ${forkSource}::uuid, ${forkAfterTurn}::uuid, ${settings}::jsonb, 'creating', ${request.title.trim() || request.initialMessage.trim().split("\n")[0]?.slice(0, 60) || "New thread"}, ${request.title.trim() ? "user" : "provisional"},
                          ${worktreeId}::uuid, ${request.clientRequestId || null}, ${preparationFingerprint ?? null}, ${audience})`;

          if (automated?.startedByBot)
            yield* sql`INSERT INTO bot_started_threads(thread_id, bot_id) VALUES (${id}::uuid, ${automated.startedByBot}::uuid)`;

          if (request.initialMessage.trim() && !preparationFingerprint) {
            yield* sql`
                    INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                    VALUES (${Bun.randomUUIDv7()}::uuid, ${id}::uuid, 1, 'user', ${ownerUserId}::uuid, ${request.clientRequestId || null},
                            ${initialTurnInput(request.initialMessage, humanInitialInput)}::jsonb)`;
          }

          return yield* self().thread(id);
        }),
      ),
  };
}

function initialTurnInput(text: string, humanAuthored: boolean | undefined): string {
  return JSON.stringify(humanAuthored ? { text, message: text, humanAuthored } : { text });
}

/** Only internal callers can supply a platform handoff; public requests carry no settings object. */
function creationSettings(
  request: ui.CreateThreadRequest,
  access: { permissionMode: string; permissionModeNote?: string },
  handoff?: string,
  sandboxProfile?: SandboxProfileBinding,
): string {
  return JSON.stringify({
    model: request.model,
    effort: request.effort,
    serviceTier: request.serviceTier,
    ...access,
    instructions: request.instructions,
    ...(handoff && { handoff }),
    ...(sandboxProfile && { sandboxProfile: toJson(SandboxProfileBindingSchema, sandboxProfile) }),
  });
}
