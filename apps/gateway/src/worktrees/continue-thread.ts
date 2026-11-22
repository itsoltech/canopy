import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreCheckModel } from "../core/core-models.ts";
import { requireThreadModule } from "../core/thread-module-runtime.ts";
import { coreCheckProvider, coreStartThread } from "../core/core-threads.ts";
import { coreUiThread } from "../core/core-titles.ts";
import { inheritedPermissionMode } from "../core/full-access.ts";
import type { GatewayCore } from "../core/core.ts";
import type { ThreadRow } from "../store/rows.ts";
import { corePrepareWorkspace, ownWorkspace } from "./core-worktrees.ts";
import { removedWorktreeHandoff } from "./continuation-handoff.ts";

/** A removed checkout never changes location: continuation creates a separate main thread and session. */
export async function continueThreadInWorktree(
  core: GatewayCore,
  input: ui.ContinueThreadInWorktreeRequest,
): Promise<ui.Thread> {
  if (!input.clientRequestId.trim()) throw new InvalidError("A request id is required to continue this thread");

  if (!input.baseRef.trim()) throw new InvalidError("Choose a branch or commit for the new worktree");
  const owner = core[coreState].options.userId;
  // Separate this operation's receipts from ordinary new-thread creation, binding retries to their source.
  const requestId = `worktree-continuation:${input.threadId}:${input.clientRequestId}`;

  return core[coreState].actions.transaction(async () => {
    await requireThreadModule(core);
    await core[coreState].actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Serialize before preparing Git, not merely before inserting the thread (regular CreateThread).
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${owner}:${requestId}`}, 9236))`;
        yield* sql`SELECT id FROM threads WHERE id=${input.threadId}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`;
      }),
    );
    const source = await coreRun(core, (s) => s.thread(input.threadId));

    if (source.owner_user_id !== owner || source.deleted_at) throw new InvalidError("Thread not found");
    await checkSource(core, source);
    const previous = await coreRun(core, (s) => s.threadByCreation(owner, requestId));

    // Its CreateThread command was committed with the seed and is already recoverable by the outbox.
    if (previous) return coreUiThread(core, previous);
    const original = coreUiThread(core, source);

    const request = create(ui.CreateThreadRequestSchema, {
      projectId: source.project_id,
      workspaceId: source.workspace_id ?? "",
      provider: original.provider,
      providerProfileId: original.providerProfileId,
      model: source.settings.model ?? "",
      effort: source.settings.effort ?? "",
      serviceTier: source.settings.serviceTier ?? "",
      instructions: source.settings.instructions ?? "",
      permissionMode: inheritedPermissionMode(original.permissionMode),
      title: `${source.title} (continued)`.slice(0, 200),
      workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
      baseRef: input.baseRef,
      clientRequestId: requestId,
    });

    await coreCheckProvider(core, request);
    await coreCheckModel(
      core,
      {
        workspaceId: request.workspaceId,
        provider: request.provider,
        profileId: request.providerProfileId,
      },
      request.model,
      request.effort,
      request.serviceTier,
    );
    const handoff = await removedWorktreeHandoff(core, source);
    const prepared = await corePrepareWorkspace(core, request);

    const row = await coreRun(core, (s) =>
      s.createThread(
        owner,
        prepared.request,
        undefined,
        source.memory_audience ? { memoryAudience: source.memory_audience } : undefined,
        handoff,
      ),
    );

    // Settings and outbox are committed together. No provider fork or model turn is requested.
    await coreStartThread(core, row);

    return coreUiThread(core, row);
  });
}

async function checkSource(core: GatewayCore, source: ThreadRow): Promise<void> {
  if (source.runtime !== "worker" || !source.worktree_id || !source.workspace_id || !source.worker_id)
    throw new InvalidError("This thread has no removed managed worktree");

  const worktrees = await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ id: string }>`SELECT id FROM worktrees
        WHERE id=${source.worktree_id}::uuid AND owner_user_id=${source.owner_user_id}::uuid
          AND project_id=${source.project_id}::uuid AND workspace_id=${source.workspace_id}::uuid
          AND worker_id=${source.worker_id}::uuid AND NOT external
          AND EXISTS (SELECT 1 FROM project_workspaces pw WHERE pw.id=workspace_id AND pw.archived_at IS NULL)
          AND removed_at IS NOT NULL AND removal_token IS NULL FOR SHARE`;
    }),
  );

  if (!worktrees.length) throw new InvalidError("Only a removed managed worktree can be continued in a new worktree");
  const { project, workspace } = await ownWorkspace(core, source.workspace_id);

  if (project.id !== source.project_id || workspace.workerId !== source.worker_id)
    throw new InvalidError("The original workspace is no longer available");
}
