import { requireThreadModule } from "./thread-module-runtime.ts";
import { coreCreateThread } from "./create-thread.ts";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { CreationProgress } from "./thread-progress.ts";
import { ForkSpecSchema, Provider, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { NotFound, type ThreadRow } from "../store/index.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import { coreState, InvalidError, TTL } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreCheckFullAccess, inheritedPermissionMode } from "./full-access.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreUiThread } from "./core-titles.ts";
import { coreBroadcastThread, coreRun } from "./core-broadcast.ts";
import { coreAnnounceSchedule } from "./core-schedules.ts";
import type { AutomatedAccess } from "../store/automated-permissions.ts";

/**
 * The worker's last report (ConfigApplied) must offer the provider and the profile for it. A worker that
 * has not reported yet is not judged: the thread waits for it like for an offline worker.
 */
export async function coreCheckProvider(
  hostContext: GatewayCore,
  request: ui.CreateThreadRequest,
  automated = false,
): Promise<void> {
  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);

  if (!workspace) return; // the store reports the missing workspace

  if (!automated) coreCheckFullAccess(hostContext, workspace.workerId, request.permissionMode);
  const worker = (await coreWorkers(hostContext)).find((w) => w.id === workspace.workerId);

  if (!worker || worker.appliedVersion === 0n) return;

  const name = request.provider === Provider.CLAUDE ? "Claude" : request.provider === Provider.GROK ? "Grok" : "Codex";

  const provider = worker.providers.find((p) => p.provider === request.provider);

  if (!provider?.available)
    throw new InvalidError(
      `${name} is not available on ${worker.name}${provider?.detail ? `: ${provider.detail}` : ""}`,
    );
  const profileId = request.providerProfileId || "native";
  const instance = worker.providerInstances.find((i) => i.harness === request.provider && i.id === profileId);

  if (!instance) throw new InvalidError(`${name} has no provider instance "${profileId}"`);

  if (!instance.enabled)
    throw new InvalidError(`${name} · ${instance.label || profileId} is turned off on ${worker.name}`);
  const profile = worker.profiles.find((p) => p.id === profileId && p.providers.includes(request.provider));

  if (!profile) throw new InvalidError(`${name} · ${instance.label || profileId} is not applied on ${worker.name} yet`);

  if (!profile.available)
    throw new InvalidError(
      `${name} · ${instance.label || profileId} is not available on ${worker.name}${profile.detail ? `: ${profile.detail}` : ""}`,
    );
}

/**
 * "Fork from here" (fork_at_turn_id without a parent): a new main thread placed and set up like the thread it
 * forks from (same project, workspace, directory, provider instance, model, effort, mode and instructions).
 * The store checks the turn (store.createThread).
 */
export async function coreForkRequest(
  hostContext: GatewayCore,
  request: ui.CreateThreadRequest,
): Promise<ui.CreateThreadRequest> {
  if (!request.forkThreadId) throw new InvalidError("fork_at_turn_id needs the thread to fork from (fork_thread_id)");
  const from = await coreRun(hostContext, (s) => s.thread(request.forkThreadId));

  if (from.owner_user_id !== hostContext[coreState].options.userId) throw new InvalidError("thread not found");

  if (from.runtime !== "worker" || !from.workspace_id) throw new InvalidError("only threads on a worker can be forked");
  const source = coreUiThread(hostContext, from);

  return create(ui.CreateThreadRequestSchema, {
    ...request,
    projectId: from.project_id,
    workspaceId: from.workspace_id,
    cwd: from.cwd ?? "",
    provider: source.provider,
    providerProfileId: source.providerProfileId,
    model: source.model,
    effort: source.effort,
    serviceTier: source.serviceTier,
    // Full access is chosen again in the fork, never inherited (docs/threads.md).
    permissionMode: inheritedPermissionMode(source.permissionMode),
    instructions: from.settings.instructions ?? "",
    fork: false,
    title: request.title.trim() || `Fork of ${from.title}`,
    // The fork works in the source's worktree (docs/worktrees.md).
    workspaceMode: from.worktree_id ? ui.WorkspaceMode.EXISTING_WORKTREE : ui.WorkspaceMode.CHECKOUT,
    worktreeId: from.worktree_id ?? "",
  });
}

/** CreateThread to the worker (with the fork point of a forked thread), then announce the thread. */
export async function coreStartThread(hostContext: GatewayCore, row: ThreadRow): Promise<void> {
  const spec = await coreRun(hostContext, (s) => Effect.succeed(s.threadSpec(row)));
  let fork: MessageInitShape<typeof ForkSpecSchema> | undefined;

  if (row.fork_source_thread_id) {
    const source = await coreRun(hostContext, (s) => s.thread(row.fork_source_thread_id ?? ""));
    const turns = await coreRun(hostContext, (s) => s.turnsOf(source.id));
    // The fork point the database pinned at insert (a chosen turn, or the latest completed one then).
    const last = turns.find((t) => t.id === row.fork_after_turn_id);
    fork = {
      sourceThreadId: source.id,
      sourceProviderThreadId: last?.provider_session_id ?? source.provider_thread_id ?? "",
      afterTurnId: last?.id ?? "",
      afterProviderTurnRef: last?.provider_turn_ref ?? "",
    };
  }

  await hostContext[coreState].actions.transaction(async () => {
    await requireThreadModule(hostContext);
    await coreDispatch(
      hostContext,
      row.worker_id ?? "",
      { kind: { case: "createThread", value: { thread: spec, ...(fork && { fork }) } } },
      { threadId: row.id, ttlSeconds: TTL.createThread },
    );
  });

  if (hostContext[coreState].actions.defer(() => coreBroadcastThread(hostContext, row.id))) return;
  hostContext.hub.publishOverview(
    create(ui.OverviewUpdateSchema, { change: { case: "thread", value: coreUiThread(hostContext, row) } }),
  );
}

/** Automatic archival uses the same locks, cascade, cleanup and broadcasts as the user's action. */
export async function coreArchiveThread(
  hostContext: GatewayCore,
  threadId: string,
  archived: boolean,
  reason: "user" | "merge" = "user",
): Promise<void> {
  const { ids, commands } = await coreRun(hostContext, (s) =>
    s.setThreadArchived(hostContext[coreState].options.userId, threadId, archived, reason),
  );

  for (const entry of commands) void coreDeliver(hostContext, entry.workerId, entry.command);

  for (const id of ids) {
    await coreBroadcastThread(hostContext, id);

    for (const schedule of await hostContext.listSchedules(
      create(ui.ListSchedulesRequestSchema, { threadId: id, includeFinished: true }),
    ))
      coreAnnounceSchedule(hostContext, schedule);
  }
}

export interface CoreThreadsMethods {
  reorderThread(request: ui.ReorderThreadRequest): Promise<ui.Thread>;
  listThreads(projectId: string, includeArchived?: boolean, sidebarOnly?: boolean): Promise<ui.Thread[]>;
  listArchivedThreads(request: ui.ListArchivedThreadsRequest): Promise<ui.ListArchivedThreadsResponse>;
  getThread(threadId: string): Promise<ui.Thread>;
  setThreadRead(threadId: string, unread: boolean): Promise<ui.Thread>;
  setThreadArchived(threadId: string, archived: boolean): Promise<ui.Thread>;
  deleteThread(threadId: string): Promise<string[]>;
  restoreThread(threadId: string): Promise<ui.Thread[]>;
  markThreadSeen(threadId: string, upToSeq: bigint): Promise<ui.Thread>;
  createThread(
    input: ui.CreateThreadRequest,
    remoteParent?: {
      ref: string;
      kind: string;
      instructions: string;
      interactions: string;
      permissionModeNote?: string;
    },
    ownerInput?: boolean,
    automated?: AutomatedAccess,
    progress?: CreationProgress,
  ): Promise<ui.Thread>;
}

export const coreThreadsMethods: CoreThreadsMethods = {
  async reorderThread(this: GatewayCore, request: ui.ReorderThreadRequest): Promise<ui.Thread> {
    await coreRun(this, (s) => s.reorderThread(this[coreState].options.userId, request));
    await coreBroadcastThread(this, request.threadId);

    return this.getThread(request.threadId);
  },
  async listThreads(
    this: GatewayCore,
    projectId: string,
    includeArchived = false,
    sidebarOnly = false,
  ): Promise<ui.Thread[]> {
    return (
      await coreRun(this, (s) => s.listThreads(this[coreState].options.userId, projectId, includeArchived, sidebarOnly))
    ).map((row) => coreUiThread(this, row));
  },

  async listArchivedThreads(
    this: GatewayCore,
    request: ui.ListArchivedThreadsRequest,
  ): Promise<ui.ListArchivedThreadsResponse> {
    const result = await coreRun(this, (s) => s.listArchivedThreads(this[coreState].options.userId, request));

    return create(ui.ListArchivedThreadsResponseSchema, {
      ...result,
      threads: result.threads.map((row) => coreUiThread(this, row)),
      sideThreads: result.sideThreads.map((row) => coreUiThread(this, row)),
    });
  },

  async getThread(this: GatewayCore, threadId: string): Promise<ui.Thread> {
    const row = await coreRun(this, (s) => s.thread(threadId, false, true));

    if (row.owner_user_id !== this[coreState].options.userId) throw new NotFound("thread not found");

    return coreUiThread(this, row);
  },

  async setThreadRead(this: GatewayCore, threadId: string, unread: boolean): Promise<ui.Thread> {
    await coreRun(this, (s) => s.setThreadRead(this[coreState].options.userId, threadId, unread));
    await coreBroadcastThread(this, threadId);

    return this.getThread(threadId);
  },

  async setThreadArchived(this: GatewayCore, threadId: string, archived: boolean): Promise<ui.Thread> {
    await coreArchiveThread(this, threadId, archived);

    return this.getThread(threadId);
  },

  async deleteThread(this: GatewayCore, threadId: string): Promise<string[]> {
    const { ids, commands } = await coreRun(this, (s) => s.deleteThread(this[coreState].options.userId, threadId));

    for (const entry of commands) void coreDeliver(this, entry.workerId, entry.command);

    for (const id of ids) await coreBroadcastThread(this, id);

    return ids;
  },

  async restoreThread(this: GatewayCore, threadId: string): Promise<ui.Thread[]> {
    const ids = await coreRun(this, (s) => s.restoreThread(this[coreState].options.userId, threadId));

    for (const id of ids) await coreBroadcastThread(this, id);

    return Promise.all(ids.map((id) => this.getThread(id)));
  },

  /** The user saw the thread up to an event: a lower marker changes nothing; a new one reaches every device. */
  async markThreadSeen(this: GatewayCore, threadId: string, upToSeq: bigint): Promise<ui.Thread> {
    if (await coreRun(this, (s) => s.markThreadSeen(this[coreState].options.userId, threadId, upToSeq)))
      await coreBroadcastThread(this, threadId);

    return this.getThread(threadId);
  },

  createThread: coreCreateThread,
};
