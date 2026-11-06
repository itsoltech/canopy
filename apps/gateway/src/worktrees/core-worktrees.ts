import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import type { WorktreeRow } from "../store/index.ts";
import { isAbsolutePath, isWithinWorkspace, normalizePath, pathStyle } from "../store/paths.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { initialBranch } from "./branch-names.ts";
import { resolveScope, settingsJson, settingsProblem, type ResolvedScope } from "./settings.ts";
import { selectWorktree, mergeWorktrees } from "./discovery.ts";

/** Git worktrees in the gateway (docs/worktrees.md): settings scopes, refs for the composer, new worktrees. */

const REFS_TIMEOUT_MS = 20_000;

/** Creating may fetch first (20 s on the worker) and check out a large tree. */
const CREATE_TIMEOUT_MS = 90_000;

/** The owner's workspace and its project; a workspace of someone else's project is not found. */
export async function ownWorkspace(hostContext: GatewayCore, workspaceId: string) {
  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  const project = projects.find((p) => p.workspaces.some((w) => w.id === workspaceId));
  const workspace = project?.workspaces.find((w) => w.id === workspaceId);

  if (!project || !workspace) throw new InvalidError("workspace not found");
  const worker = (await coreWorkers(hostContext)).find((w) => w.id === workspace.workerId && !w.nodeId);

  if (!worker) throw new InvalidError("worker not found");

  return { project, workspace, worker };
}

/** A scope names the owner's project and a worker the owner may use (empty = all). */
async function checkScope(hostContext: GatewayCore, projectId: string, workerId: string): Promise<void> {
  if (projectId) {
    const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));

    if (!projects.some((p) => p.id === projectId && p.kind !== "scratch")) throw new InvalidError("project not found");
  }

  if (workerId && !(await coreWorkers(hostContext)).some((w) => w.id === workerId && !w.nodeId))
    throw new InvalidError("worker not found");
}

export async function coreWorktreeScope(
  hostContext: GatewayCore,
  projectId: string,
  workerId: string,
): Promise<ResolvedScope> {
  const rows = await coreRun(hostContext, (s) =>
    s.worktreeScopes(hostContext[coreState].options.userId, projectId || null, workerId || null),
  );

  return resolveScope(rows, projectId || null, workerId || null);
}

function scopeResponse(projectId: string, workerId: string, scope: ResolvedScope): ui.WorktreeSettingsResponse {
  return create(ui.WorktreeSettingsResponseSchema, {
    projectId,
    workerId,
    settings: scope.own,
    inherited: scope.inherited,
    effective: scope.effective,
    version: scope.version,
    inheritedSources: scope.inheritedSources,
  });
}

export function toUiWorktree(row: WorktreeRow): ui.ThreadWorktree {
  return create(ui.ThreadWorktreeSchema, {
    id: row.id,
    branch: row.branch,
    path: row.path,
    baseRef: row.base_ref,
    repoRoot: row.repo_root,
    workerId: row.worker_id,
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.removed_at && { removedAt: timestampFromDate(new Date(row.removed_at)) }),
    detachedCommit: row.detached_commit,
    provisionalBranch: row.branch_source === "provisional",
    external: row.external,
  });
}

/** The worker's open link when it offers worktrees; otherwise why not (offline is Unavailable). */
function worktreeLink(hostContext: GatewayCore, workerId: string) {
  const connection = hostContext.link.connections.get(workerId);

  if (connection?.isOpen && !connection.hello.capabilities.includes("worktrees"))
    return { connection: undefined, detail: "This worker's Canopy version does not support worktrees. Update it." };

  return { connection, detail: "" };
}

/** A new worktree for a new main thread, created on the workspace's worker before the thread. */
async function createWorktree(hostContext: GatewayCore, request: ui.CreateThreadRequest) {
  const { project, workspace, worker } = await ownWorkspace(hostContext, request.workspaceId);

  if (project.id !== request.projectId) throw new InvalidError("workspace not found");

  if (project.kind === "scratch") throw new InvalidError("a no-project thread has no repository for a worktree");
  const { connection, detail } = worktreeLink(hostContext, workspace.workerId);

  if (connection === undefined && detail) throw new InvalidError(detail);
  const settings = (await coreWorktreeScope(hostContext, project.id, workspace.workerId)).effective;
  const id = Bun.randomUUIDv7();

  const branch = initialBranch(settings, {
    message: request.initialMessage,
    title: request.title,
    shortId: id.slice(-8),
  });

  const semantic = settings.branchNaming === ui.BranchNaming.SEMANTIC;

  const result = await coreWorkerQuery(
    hostContext,
    workspace.workerId,
    {
      case: "createWorktree",
      value: {
        repoPath: workspace.rootPath,
        baseRef: request.baseRef,
        branch,
        location: settings.location ?? "",
        startFromRemote: settings.startFromRemote ?? false,
        remote: settings.remote ?? "origin",
      },
    },
    CREATE_TIMEOUT_MS,
  );

  const info = result.worktree;
  const style = pathStyle(worker.os, workspace.rootPath);
  const root = settings.location || connection?.hello.worktreesRoot || "";

  // The worker computed the path under its root; trust it only there (docs/worktrees.md, "Bezpieczeństwo").
  if (
    !info?.path ||
    !root ||
    !isAbsolutePath(info.path, style) ||
    normalizePath(info.path, style) === normalizePath(root, style) ||
    !isWithinWorkspace(normalizePath(info.path, style), root, style, worker?.os)
  )
    throw new InvalidError("the worker created the worktree outside its root");

  const row = await coreRun(hostContext, (s) =>
    s.insertWorktree({
      id,
      owner_user_id: hostContext[coreState].options.userId,
      project_id: project.id,
      workspace_id: workspace.id,
      worker_id: workspace.workerId,
      repo_root: info.repoRoot,
      path: info.path,
      branch: info.branch,
      base_ref: info.baseRef,
      base_commit: info.baseCommit,
      location: settings.location ?? "",
      provisional: semantic,
    }),
  );

  return { row, semantic, location: settings.location ?? "" };
}

export interface PreparedWorkspace {
  readonly request: ui.CreateThreadRequest;
  /** After the thread exists: ask the model for a semantic branch name (branch-naming.ts). */
  readonly nameLater?: { worktree: WorktreeRow; location: string };
}

/**
 * CreateThread's workspace: create a requested worktree now; side threads inherit unless explicitly placed.
 * Resolve the directory here too so first-message file mentions use that placement.
 */
export async function corePrepareWorkspace(
  hostContext: GatewayCore,
  request: ui.CreateThreadRequest,
): Promise<PreparedWorkspace> {
  if (request.parentThreadId) {
    const parent = await coreRun(hostContext, (s) => s.thread(request.parentThreadId));

    if (parent.owner_user_id !== hostContext[coreState].options.userId) throw new InvalidError("thread not found");

    if (parent.workspace_id !== request.workspaceId || parent.project_id !== request.projectId)
      throw new InvalidError("a side thread runs in its parent's workspace");

    if (!request.workspaceMode || request.workspaceMode === ui.WorkspaceMode.INHERIT_PARENT)
      return { request: create(ui.CreateThreadRequestSchema, { ...request, cwd: parent.cwd ?? "" }) };
  } else if (request.workspaceMode === ui.WorkspaceMode.INHERIT_PARENT) {
    throw new InvalidError("inherit_parent requires a parent thread");
  }

  if (!request.workspaceMode) {
    const { project, workspace } = await ownWorkspace(hostContext, request.workspaceId);

    const mode =
      project.kind === "scratch"
        ? ui.WorkspaceMode.CHECKOUT
        : (await coreWorktreeScope(hostContext, project.id, workspace.workerId)).effective.defaultMode;

    request = create(ui.CreateThreadRequestSchema, { ...request, workspaceMode: mode });
  }

  if (request.parentThreadId && request.workspaceMode === ui.WorkspaceMode.CHECKOUT)
    request = create(ui.CreateThreadRequestSchema, { ...request, cwd: "", worktreeId: "" });

  if (request.workspaceMode === ui.WorkspaceMode.EXISTING_WORKTREE) {
    const row = await selectWorktree(hostContext, request);

    return { request: create(ui.CreateThreadRequestSchema, { ...request, worktreeId: row.id, cwd: row.path }) };
  }

  if (request.workspaceMode !== ui.WorkspaceMode.NEW_WORKTREE) return { request };
  const made = await createWorktree(hostContext, request);
  const next = create(ui.CreateThreadRequestSchema, { ...request, worktreeId: made.row.id, cwd: made.row.path });

  return {
    request: next,
    ...(made.semantic &&
      request.initialMessage.trim() && { nameLater: { worktree: made.row, location: made.location } }),
  };
}

export interface CoreWorktreesMethods {
  getWorktreeSettings(request: ui.GetWorktreeSettingsRequest): Promise<ui.WorktreeSettingsResponse>;
  updateWorktreeSettings(request: ui.UpdateWorktreeSettingsRequest): Promise<ui.WorktreeSettingsResponse>;
  listGitRefs(request: ui.ListGitRefsRequest): Promise<ui.ListGitRefsResponse>;
}

export const coreWorktreesMethods: CoreWorktreesMethods = {
  async getWorktreeSettings(this: GatewayCore, request) {
    await checkScope(this, request.projectId, request.workerId);

    return scopeResponse(
      request.projectId,
      request.workerId,
      await coreWorktreeScope(this, request.projectId, request.workerId),
    );
  },

  async updateWorktreeSettings(this: GatewayCore, request) {
    await checkScope(this, request.projectId, request.workerId);
    const settings = request.settings ?? create(ui.WorktreeSettingsSchema);
    const worker = (await coreWorkers(this)).find((w) => w.id === request.workerId);
    const style = pathStyle(worker?.os ?? "", settings.location ?? "");
    const problem = settingsProblem(settings, (path) => isAbsolutePath(path, style));

    if (problem) throw new InvalidError(problem);
    await coreRun(this, (s) =>
      s.saveWorktreeScope({
        ownerUserId: this[coreState].options.userId,
        projectId: request.projectId || null,
        workerId: request.workerId || null,
        settings: settingsJson(settings),
        expectedVersion: request.expectedVersion,
      }),
    );

    return this.getWorktreeSettings(
      create(ui.GetWorktreeSettingsRequestSchema, { projectId: request.projectId, workerId: request.workerId }),
    );
  },

  /** Refs of the workspace's repository and earlier worktrees there, for the new-thread composer. */
  async listGitRefs(this: GatewayCore, request) {
    const { project, workspace } = await ownWorkspace(this, request.workspaceId);
    const settings = (await coreWorktreeScope(this, project.id, workspace.workerId)).effective;

    if (project.kind === "scratch")
      return create(ui.ListGitRefsResponseSchema, { supported: false, detail: "No project has no repository" });
    const { detail } = worktreeLink(this, workspace.workerId);

    if (detail) return create(ui.ListGitRefsResponseSchema, { supported: false, detail, settings });

    const worktrees = await coreRun(this, (s) =>
      s.listWorktrees(this[coreState].options.userId, project.id, workspace.workerId, workspace.id),
    );

    const result = await coreWorkerQuery(
      this,
      workspace.workerId,
      {
        case: "listGitRefs",
        value: {
          repoPath: workspace.rootPath,
          remote: settings.remote ?? "origin",
          knownPaths: worktrees.map((row) => row.path),
        },
      },
      REFS_TIMEOUT_MS,
    );

    if (!result.gitRefs) throw new UnavailableError("the worker did not list the refs");

    const discovered = this.link.connections
      .get(workspace.workerId)
      ?.hello.capabilities.includes("git_worktree_discovery")
      ? result.gitRefs
      : undefined;

    return create(ui.ListGitRefsResponseSchema, {
      supported: true,
      refs: result.gitRefs,
      worktrees: mergeWorktrees(worktrees, discovered, workspace),
      detail: discovered?.worktreesDetail ?? "",
      settings,
    });
  },
};
