import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { ownWorkspace } from "./core-worktrees.ts";
import { discoverWorkspace, mergeWorktrees } from "./discovery.ts";
import { branchSwitchReason, listCheckoutBranches, switchCheckoutBranch } from "./branch-checkout.ts";

/** Resolve ids against fresh Git discovery, without adopting an external worktree during a read or switch. */
export class WorkspaceBranches {
  constructor(readonly core: GatewayCore) {}

  async #target(request: ui.WorkspaceBranchesRequest | ui.SwitchWorkspaceBranchRequest) {
    const { workspace, project } = await ownWorkspace(this.core, request.workspaceId);
    const owner = this.core[coreState].options.userId;

    if (project.kind === "scratch") throw new InvalidError("workspace not found");

    const target = {
      worker_id: workspace.workerId,
      cwd: workspace.rootPath,
      worktree_id: null,
      workspaceRepo: workspace.rootPath,
    };

    if (!request.worktreeId) return target;
    const rows = await coreRun(this.core, (s) => s.listWorktrees(owner, project.id, workspace.workerId, workspace.id));
    const discovered = await discoverWorkspace(this.core, workspace, true);

    if (!discovered || discovered.worktreesDetail)
      throw new InvalidError(discovered?.worktreesDetail || "Update and reconnect this computer to select a worktree.");
    const selected = mergeWorktrees(rows, discovered, workspace).find((tree) => tree.id === request.worktreeId);

    if (!selected || selected.unavailableReason || selected.locked || selected.prunable || selected.missing)
      throw new InvalidError(selected?.unavailableReason || "Worktree unavailable. Refresh and choose a worktree.");
    const registered = rows.find((row) => row.id === selected.id);

    return { ...target, cwd: selected.path, worktree_id: registered?.id ?? null };
  }

  async list(request: ui.WorkspaceBranchesRequest): Promise<ui.ListGitRefsResponse> {
    const { workspace } = await ownWorkspace(this.core, request.workspaceId);
    const detail = branchSwitchReason(this.core, workspace.workerId, false, true);

    if (detail) return create(ui.ListGitRefsResponseSchema, { detail });
    const target = await this.#target(request);

    return listCheckoutBranches(this.core, target.worker_id, target.cwd);
  }

  async switch(request: ui.SwitchWorkspaceBranchRequest): Promise<ui.SwitchWorkspaceBranchResponse> {
    const target = await this.#target(request);

    const detail = await switchCheckoutBranch(this.core, target, request, {
      id: request.workspaceId,
      worktreeId: request.worktreeId,
    });

    const listed = await listCheckoutBranches(this.core, target.worker_id, target.cwd);

    return create(ui.SwitchWorkspaceBranchResponseSchema, { refs: listed.refs, detail });
  }
}
