import { create } from "@bufbuild/protobuf";
import { ui, type GitRefs, type GitWorktree } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import type { WorktreeRow } from "../store/worktrees.ts";
import { ownWorkspace, toUiWorktree } from "./core-worktrees.ts";
import { coreWorkers } from "../core/core-providers.ts";

/** A stable opaque id before adoption; includes the workspace so it grants no cross-project authority. */
function discoveredId(workspaceId: string, path: string): string {
  const hex = new Bun.CryptoHasher("sha256").update(`${workspaceId}\0${path}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function discoverWorkspace(core: GatewayCore, workspace: ui.Workspace, fresh = false) {
  const connection = core.link.connections.get(workspace.workerId);

  if (!connection?.isOpen || !connection.hello.capabilities.includes("git_worktree_discovery")) return undefined;

  const rows = await coreRun(core, (s) =>
    s.listWorktrees(core[coreState].options.userId, workspace.projectId, workspace.workerId, workspace.id),
  );

  const result = await coreWorkerQuery(
    core,
    workspace.workerId,
    {
      case: "listGitRefs",
      value: {
        repoPath: workspace.rootPath,
        worktreesOnly: true,
        freshWorktrees: fresh,
        knownPaths: rows.map((row) => row.path),
      },
    },
    5_000,
  );

  return result.gitRefs;
}

function metadata(tree: GitWorktree) {
  return {
    branch: tree.branch,
    detachedCommit: tree.detached ? tree.headCommit.slice(0, 12) : "",
    locked: tree.locked,
    prunable: tree.prunable,
    missing: tree.missing,
    unavailableReason: tree.unavailableReason,
  };
}

export function mergeWorktrees(
  rows: readonly WorktreeRow[],
  discovered: GitRefs | undefined,
  workspace?: ui.Workspace,
): ui.ThreadWorktree[] {
  const live = new Map(discovered?.worktrees.map((tree) => [tree.path, tree]));
  const checkout = discovered?.repoRoot;

  const result = rows.flatMap((row) => {
    if (row.path === checkout) return [];
    const tree = live.get(row.path) ?? [...live.values()].find((tree) => tree.aliases.includes(row.path));

    if (tree && tree.path === checkout) return [];
    live.delete(tree?.path ?? row.path);

    return [
      create(ui.ThreadWorktreeSchema, {
        ...toUiWorktree(row),
        ...(tree
          ? metadata(tree)
          : discovered && !discovered.worktreesDetail
            ? { missing: true, unavailableReason: "Worktree no longer registered in git" }
            : row.external
              ? { unavailableReason: "Worktree unavailable. Refresh to retry." }
              : {}),
      }),
    ];
  });

  if (workspace)
    for (const tree of live.values()) {
      if (tree.path === checkout) continue;
      result.push(
        create(ui.ThreadWorktreeSchema, {
          id: discoveredId(workspace.id, tree.path),
          path: tree.path,
          repoRoot: checkout ?? "",
          workerId: workspace.workerId,
          external: true,
          ...metadata(tree),
        }),
      );
    }

  return result;
}

/** A selection is re-discovered without cache; no client-supplied path reaches a worker command. */
export async function selectWorktree(core: GatewayCore, request: ui.CreateThreadRequest): Promise<WorktreeRow> {
  const { project, workspace } = await ownWorkspace(core, request.workspaceId);

  if (project.id !== request.projectId || project.kind === "scratch") throw new InvalidError("workspace not found");
  const owner = core[coreState].options.userId;
  const rows = await coreRun(core, (s) => s.listWorktrees(owner, project.id, workspace.workerId, workspace.id));
  const existing = rows.find((row) => row.id === request.worktreeId);
  const discovered = await discoverWorkspace(core, workspace, true);

  if (!discovered) {
    if (existing?.external) throw new InvalidError("Reconnect and update this worker to use external worktrees.");

    return coreRun(core, (s) => s.ownWorktree(owner, request.worktreeId, project.id, workspace.id));
  }

  if (discovered.worktreesDetail) throw new InvalidError(discovered.worktreesDetail);
  const selected = mergeWorktrees(rows, discovered, workspace).find((tree) => tree.id === request.worktreeId);

  if (!selected || selected.unavailableReason || selected.locked || selected.prunable || selected.missing)
    throw new InvalidError(selected?.unavailableReason || "Worktree unavailable. Refresh and choose a worktree.");

  if (existing) return coreRun(core, (s) => s.ownWorktree(owner, existing.id, project.id, workspace.id));

  return coreRun(core, (s) =>
    s.insertWorktree({
      id: selected.id,
      owner_user_id: owner,
      project_id: project.id,
      workspace_id: workspace.id,
      worker_id: workspace.workerId,
      repo_root: selected.repoRoot,
      path: selected.path,
      branch: selected.branch,
      detachedCommit: selected.detachedCommit,
      base_ref: "",
      base_commit: "",
      external: true,
    }),
  );
}

/** Owner-scoped workspace enumeration; linked workspaces are queried at their home gateway. */
export async function discoveredInventory(core: GatewayCore, projectId: string, workerId: string) {
  const projects = await coreRun(core, (s) => s.listProjects(core[coreState].options.userId));
  const allowedWorkers = new Set((await coreWorkers(core)).flatMap((worker) => (worker.nodeId ? [] : [worker.id])));
  const entries: ui.WorktreeEntry[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    if (project.kind === "scratch" || (projectId && project.id !== projectId)) continue;

    for (const workspace of project.workspaces) {
      if (!allowedWorkers.has(workspace.workerId)) continue;

      if (workerId && workspace.workerId !== workerId) continue;
      const discovered = await discoverWorkspace(core, workspace).catch(() => undefined);

      const rows = await coreRun(core, (s) =>
        s.listWorktrees(core[coreState].options.userId, project.id, workspace.workerId, workspace.id),
      );

      for (const tree of mergeWorktrees(rows, discovered, workspace)) {
        if (!tree.external) continue;
        const key = `${workspace.workerId}\0${tree.path}`;

        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(
          create(ui.WorktreeEntrySchema, {
            worktree: tree,
            projectId: project.id,
            online: true,
            detail: tree.unavailableReason || "Created outside Canopy",
          }),
        );
      }
    }
  }

  return entries;
}

export async function appendDiscovered(
  core: GatewayCore,
  entries: ui.WorktreeEntry[],
  rows: readonly WorktreeRow[],
  projectId: string,
  workerId: string,
): Promise<void> {
  const discovered = await discoveredInventory(core, projectId, workerId);
  const registered = new Set(rows.map((row) => `${row.worker_id}\0${row.path}`));
  entries.push(
    ...discovered.filter((entry) => !registered.has(`${entry.worktree?.workerId}\0${entry.worktree?.path}`)),
  );
}
