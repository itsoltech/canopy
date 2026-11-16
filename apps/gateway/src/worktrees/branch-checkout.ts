import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  GIT_BRANCH_SWITCH_CAPABILITY,
  GIT_BRANCH_STASH_CAPABILITY,
  WORKSPACE_BRANCH_SWITCH_CAPABILITY,
} from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun, coreBroadcastThread } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import {
  branchCheckoutPaths,
  branchSwitchNotices,
  lockBranchCheckout,
  lockBranchWorktree,
  saveWorkspaceBranch,
  type BranchCheckout,
} from "../store/thread-branches.ts";

export function branchSwitchReason(core: GatewayCore, workerId: string, stash = false, workspace = false) {
  const connection = core.link.connections.get(workerId);

  if (!connection?.isOpen) return "This computer is offline. Reconnect it to switch branches.";
  const capabilities = connection.hello.capabilities;

  if (
    !capabilities.includes(GIT_BRANCH_SWITCH_CAPABILITY) ||
    (stash && !capabilities.includes(GIT_BRANCH_STASH_CAPABILITY)) ||
    (workspace && !capabilities.includes(WORKSPACE_BRANCH_SWITCH_CAPABILITY))
  )
    return "Update this computer to switch branches.";

  return undefined;
}

export async function listCheckoutBranches(core: GatewayCore, worker: string, cwd: string) {
  const result = await coreWorkerQuery(
    core,
    worker,
    { case: "listGitRefs", value: { repoPath: cwd, branchesOnly: true } },
    30_000,
  );

  return create(ui.ListGitRefsResponseSchema, { supported: Boolean(result.gitRefs?.isRepo), refs: result.gitRefs });
}

export async function switchCheckoutBranch(
  core: GatewayCore,
  target: BranchCheckout & { worker_id: string; cwd: string; workspaceRepo?: string },
  request: Pick<ui.SwitchThreadBranchRequest, "branch" | "remote" | "stashChanges">,
  workspace?: { id: string; worktreeId: string },
) {
  const reason = branchSwitchReason(core, target.worker_id, request.stashChanges, Boolean(workspace));

  if (reason) throw new InvalidError(reason);
  const actions = core[coreState].actions;
  const knownPaths = await actions.run(branchCheckoutPaths(target.worker_id));

  const rootResult = await coreWorkerQuery(
    core,
    target.worker_id,
    { case: "listGitRefs", value: { repoPath: target.cwd, worktreesOnly: true, branchesOnly: true, knownPaths } },
    30_000,
  );

  const root = rootResult.gitRefs?.repoRoot;

  if (!root) throw new InvalidError("This directory is not a git checkout.");

  const stored = await actions.transaction(async () => {
    const ids = await actions.run(
      lockBranchCheckout(core[coreState].options.userId, target, rootResult.gitRefs?.sameCheckoutPaths ?? []),
    );

    if (target.id && !ids.includes(target.id))
      throw new InvalidError("The working directory changed. Refresh the thread.");

    if (target.worktree_id)
      await actions.run(lockBranchWorktree(core[coreState].options.userId, target.worktree_id, target.cwd));

    const result = await coreWorkerQuery(
      core,
      target.worker_id,
      {
        case: "switchThreadBranch",
        value: {
          threadId: target.id ?? "",
          cwd: target.cwd,
          branch: request.branch,
          remote: request.remote,
          stashChanges: request.stashChanges,
          expiresAtMs: BigInt(Date.now() + 90_000),
          expectedCheckout: root,
          workspaceRepo: target.workspaceRepo ?? "",
        },
      },
      120_000,
    );

    const head = result.switchedHead;

    if (!head?.branch) throw new InvalidError("Could not read the current branch. Refresh and try again.");
    await coreRun(core, (s) => s.saveGitHead(target.worker_id, ids, head));

    if (workspace)
      await actions.run(
        saveWorkspaceBranch(core[coreState].options.userId, workspace.id, workspace.worktreeId, head.branch),
      );

    return { events: await actions.run(branchSwitchNotices(ids, head.branch)), detail: result.branchSwitchWarning };
  });

  for (const event of stored.events) {
    core.githubDetection.request(event.threadId);
    core.hub.publishThread(
      event.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: event.seq, event: event.event } } }),
    );
    await coreBroadcastThread(core, event.threadId);
  }

  return stored.detail;
}
