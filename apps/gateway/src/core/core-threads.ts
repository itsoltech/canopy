import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { coreShellInput } from "./core-shell.ts";
import { ForkSpecSchema, Provider, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { harnessOf, NotFound, turnEffort, type ThreadRow } from "../store/index.ts";
import { titleContext } from "./thread-titles.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import { coreState, InvalidError, TTL } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreCheckFullAccess, inheritedPermissionMode } from "./full-access.ts";
import { coreMessageAttachments } from "./core-attachments.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { coreCheckModel, coreProfileModels } from "./core-models.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreAutoTitle, coreUiThread } from "./core-titles.ts";
import { coreBroadcastThread, coreRun } from "./core-broadcast.ts";
import { coreAnnounceSchedule } from "./core-schedules.ts";
import { corePrepareWorkspace } from "../worktrees/core-worktrees.ts";
import { coreNameBranchLater } from "../worktrees/branch-naming.ts";
import type { AutomatedAccess } from "../store/automated-permissions.ts";
import { checkedQuotes, coreCheckQuoteSources } from "./quotes.ts";

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

  await coreDispatch(
    hostContext,
    row.worker_id ?? "",
    { kind: { case: "createThread", value: { thread: spec, ...(fork && { fork }) } } },
    { threadId: row.id, ttlSeconds: TTL.createThread },
  );
  hostContext.hub.publishOverview(
    create(ui.OverviewUpdateSchema, { change: { case: "thread", value: coreUiThread(hostContext, row) } }),
  );
}

async function completedCreation(core: GatewayCore, input: ui.CreateThreadRequest) {
  const previous = await coreRun(core, (s) =>
    s.threadByCreation(core[coreState].options.userId, input.clientRequestId),
  );

  if (!previous) return;

  const ready =
    (!input.initialMessage && !input.initialAttachmentIds.length && !input.initialQuotes.length) ||
    (await coreRun(core, (s) => s.turnByClientRequest(previous.id, input.clientRequestId)));

  if (!ready) return;

  if (previous.status === "creating") await coreStartThread(core, previous);

  return coreUiThread(core, previous);
}

async function initialQuotes(core: GatewayCore, request: ui.CreateThreadRequest) {
  const quotes = checkedQuotes(
    request.initialQuotes,
    (reason) => new InvalidError(reason),
    request.initialMessage,
    request.initialMentions,
  );

  for (const quote of quotes)
    if (quote.sourceThreadId) await coreCheckQuoteSources(core, [quote], quote.sourceThreadId);

  return quotes;
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
    const { ids, commands } = await coreRun(this, (s) =>
      s.setThreadArchived(this[coreState].options.userId, threadId, archived),
    );

    for (const entry of commands) void coreDeliver(this, entry.workerId, entry.command);

    for (const id of ids) {
      await coreBroadcastThread(this, id);

      for (const schedule of await this.listSchedules(
        create(ui.ListSchedulesRequestSchema, { threadId: id, includeFinished: true }),
      ))
        coreAnnounceSchedule(this, schedule);
    }

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

  async createThread(
    this: GatewayCore,
    input: ui.CreateThreadRequest,
    remoteParent?: {
      ref: string;
      kind: string;
      instructions: string;
      interactions: string;
      permissionModeNote?: string;
    },
    ownerInput = false,
    automated = remoteParent ? { permissionModeNote: remoteParent.permissionModeNote ?? "" } : undefined,
  ): Promise<ui.Thread> {
    const previous = await completedCreation(this, input);

    if (previous) return previous;
    const source = input.forkAtTurnId && !input.parentThreadId ? await coreForkRequest(this, input) : input;
    const asked = automated ? { ...source, permissionMode: input.permissionMode } : source;
    await coreCheckProvider(this, asked, automated !== undefined);

    const where = {
      workspaceId: asked.workspaceId,
      provider: asked.provider,
      profileId: asked.providerProfileId,
    };

    await coreCheckModel(this, where, asked.model, asked.effort);
    // A model without efforts keeps none as the thread's default.
    const effort = turnEffort((await coreProfileModels(this, where)).models, asked.model, asked.effort);
    // A new worktree is made before the thread, which then works in it (docs/worktrees.md).
    const prepared = await corePrepareWorkspace(this, asked);
    const request = prepared.request;

    const nameBranch = (row: ThreadRow) =>
      prepared.nameLater && coreNameBranchLater(this, row, request.initialMessage, prepared.nameLater.worktree);

    if (
      request.initialAttachmentIds.length === 0 &&
      request.initialMentions.length === 0 &&
      request.initialQuotes.length === 0 &&
      !(ownerInput && request.initialMessage.startsWith("!"))
    ) {
      const row = await coreRun(this, (s) =>
        s.createThread(
          this[coreState].options.userId,
          effort === request.effort ? request : { ...request, effort },
          undefined,
          automated,
        ),
      );

      if (remoteParent) {
        await this[coreState].actions.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE threads SET remote_parent_ref=${remoteParent.ref},remote_parent_kind=${remoteParent.kind},interaction_route=${remoteParent.interactions},settings=settings || ${JSON.stringify({ instructions: remoteParent.instructions })}::jsonb WHERE id=${row.id}::uuid`;
          }),
        );
        row.remote_parent_ref = remoteParent.ref;
        row.remote_parent_kind = remoteParent.kind;
        row.interaction_route = remoteParent.interactions === "human" ? "human" : "parent";
        row.settings.instructions = remoteParent.instructions;
      }

      await coreStartThread(this, row);
      nameBranch(row);

      if (request.initialMessage.trim()) coreAutoTitle(this, row.id, titleContext({ text: request.initialMessage }));

      return coreUiThread(this, row);
    }

    // With attachments or mentions: checked first (no thread for a message that cannot go), then the first message as a turn.
    const projects = await coreRun(this, (s) => s.listProjects(this[coreState].options.userId));
    const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === request.workspaceId);

    const files =
      request.initialAttachmentIds.length > 0
        ? await coreMessageAttachments(this, request.initialAttachmentIds, workspace?.workerId ?? "")
        : undefined;

    const { mentions, goal } = await coreMessageMentions(
      this,
      { cwd: request.cwd || workspace?.rootPath || "" },
      request.initialMessage,
      request.initialMentions,
      files?.files,
    );

    const quotes = await initialQuotes(this, request);

    if (goal !== undefined && files) throw new InvalidError("a /goal message cannot carry attachments");

    const shell = ownerInput
      ? coreShellInput(request.initialMessage, Boolean(files || request.initialMentions.length))
      : undefined;

    const row = await coreRun(this, (s) =>
      s.createThread(this[coreState].options.userId, { ...request, effort, initialMessage: "" }, undefined, automated),
    );

    if (goal === undefined) {
      const provider = harnessOf(request.provider)!;

      const input =
        shell ??
        coreComposeInput(
          this,
          provider,
          request.initialMessage,
          mentions,
          files?.input(row.id, request.initialMessage, mentions),
          quotes,
        );

      await coreRun(this, (s) =>
        s.enqueueTurn({
          threadId: row.id,
          text: request.initialMessage,
          userId: this[coreState].options.userId,
          clientRequestId: request.clientRequestId,
          ...(input && { input }),
        }),
      );
    }

    await coreStartThread(this, row);
    nameBranch(row);

    // A /goal first message: the new thread's goal (Claude: its /goal turn; Codex: thread/goal/set after the thread).
    if (goal !== undefined)
      await this.setGoal(create(ui.SetGoalRequestSchema, { threadId: row.id, action: "set", objective: goal }));
    else
      coreAutoTitle(
        this,
        row.id,
        titleContext({
          text: request.initialMessage,
          mentions,
          attachments: files?.input(row.id, request.initialMessage).attachments,
        }),
      );

    return coreUiThread(this, row);
  },
};
