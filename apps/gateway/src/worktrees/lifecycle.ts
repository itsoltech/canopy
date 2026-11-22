import { ownerModuleEnabled, moduleDisabledMessage } from "../store/module-access.ts";
import { create, fromBinary } from "@bufbuild/protobuf";
import { currentProcessPriority } from "@canopy/process-governor";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { CommandSchema, WorktreeTargetSchema, ui, type Command, type WorktreeStatus } from "@canopy/contracts";
import type { WorktreeLifecycleRow } from "../store/worktree-lifecycle.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreBroadcastThread, coreRun } from "../core/core-broadcast.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import type { GatewayCore } from "../core/core.ts";
import { coreWorktreeScope, toUiWorktree } from "./core-worktrees.ts";
import { cleanupReason, closedThreadCleanup, lastActivity, matchesCleanup } from "./cleanup-policy.ts";
import { discoverWorkspace, mergeWorktrees } from "./discovery.ts";
import { ownWorkspace } from "./core-worktrees.ts";
import { githubCleanupProof } from "../github/cleanup-proof.ts";

export const mergedProof = async (
  core: GatewayCore,
  row: Pick<WorktreeLifecycleRow, "owner_user_id" | "project_id" | "worker_id">,
  repository: string,
  branch: string,
  head: string,
) =>
  (await githubCleanupProof(core.github, row.owner_user_id, row.project_id, repository, branch, head)) ||
  core.connectors.worktreeMerged(row.owner_user_id, row.project_id, row.worker_id, repository, branch, head);

export function worktreeTarget(
  row: WorktreeLifecycleRow,
  settings: ui.WorktreeSettings,
  status?: WorktreeStatus,
  confirmedPr = false,
) {
  return create(WorktreeTargetSchema, {
    id: row.id,
    path: row.path,
    repoRoot: row.repo_root,
    // Detached: the worker expects no branch checked out there (the last branch stays in the record).
    branch: row.detached_commit ? "" : row.branch,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    location: row.location,
    remote: settings.remote ?? "origin",
    mergedPrHead: confirmedPr && status ? status.headCommit : "",
    mergedPrRepository: status?.githubRepository ?? "",
  });
}

/** Complete a reserved removal, preserving its command id across disconnects and gateway restarts. */
export async function deliverRemoval(core: GatewayCore, row: WorktreeLifecycleRow, command: Command) {
  if (row.external) throw new InvalidError("Canopy cannot remove worktrees created outside Canopy.");
  const owner = core[coreState].options.userId;
  const connection = core.link.connections.get(row.worker_id);

  if (!connection?.isOpen) throw new UnavailableError("Worker offline; cleanup will retry when it reconnects");

  if (command.kind.case !== "removeWorktree") throw new InvalidError("Invalid worktree removal command");

  if (!(await core[coreState].actions.run(ownerModuleEnabled(owner, "threads"))))
    throw new InvalidError(moduleDisabledMessage("threads"));
  const kind = command.kind;
  const removal = kind.value;
  const supportsCleanup = connection.hello.capabilities.includes("archived_branch_cleanup");

  if (removal.deleteBranch && !supportsCleanup && removal.target) {
    // Legacy recovery compares every receipt byte. If the checkout is gone, only an upgraded worker can
    // reconcile the original receipt with a narrowed permission without risking another branch deletion.
    const scanned = await coreWorkerQuery(
      core,
      row.worker_id,
      {
        case: "scanWorktrees",
        value: { targets: [removal.target] },
      },
      60_000,
    );

    if (scanned.worktreeStatuses.find((status) => status.id === row.id)?.missing)
      throw new InvalidError("Update this worker to finish the interrupted worktree cleanup.");
  }

  // An older durable command can reconnect to an older worker. Never forward its legacy deletion bit.
  removal.deleteBranch = false;
  removal.trackBranchForCleanup &&= supportsCleanup;
  removal.deleteArchivedBranch &&= removal.trackBranchForCleanup && row.branch === removal.target?.branch;

  const send = async () => {
    if (removal.deleteArchivedBranch)
      removal.deleteArchivedBranch = await coreRun(core, (s) => s.lockRemovalBranch(row, command.commandId));

    if (
      removal.trackBranchForCleanup &&
      !(await coreWorktreeScope(core, row.project_id, row.worker_id)).effective.deleteLocalBranch
    ) {
      removal.deleteArchivedBranch = false;
      removal.trackBranchForCleanup = false;
    }

    return connection.sendCommand(kind, 90_000, command.commandId);
  };

  const result = removal.deleteArchivedBranch ? await core[coreState].actions.transaction(send) : await send();

  if (!result.ok) {
    await coreRun(core, (s) => s.cancelWorktreeRemoval(owner, row.id, command.commandId));
    throw new InvalidError(result.errorMessage || "Worktree removal failed");
  }

  const threads = await coreRun(core, (s) =>
    s.finishWorktreeRemoval(
      owner,
      row.id,
      command.commandId,
      result.worktreeBranchDeleted,
      result.worktreeBranchCleanupCandidate && removal.trackBranchForCleanup && !result.worktreeBranchDeleted,
    ),
  );

  for (const threadId of threads) await coreBroadcastThread(core, threadId);

  return result.worktreeBranchDeleted;
}

export async function scanEntry(core: GatewayCore, row: WorktreeLifecycleRow, fetch: boolean) {
  const connection = core.link.connections.get(row.worker_id);
  const online = Boolean(connection?.isOpen);

  const entry = create(ui.WorktreeEntrySchema, {
    worktree: toUiWorktree(row),
    projectId: row.project_id,
    online,
    busy: row.busy,
    lastActivityAt: timestampFromDate(new Date(row.last_activity_at)),
  });

  const settings = (await coreWorktreeScope(core, row.project_id, row.worker_id)).effective;

  if (row.external) {
    const { workspace } = await ownWorkspace(core, row.workspace_id);
    const discovered = await discoverWorkspace(core, workspace).catch(() => undefined);
    entry.worktree =
      mergeWorktrees([row], discovered, workspace).find((tree) => tree.id === row.id) ?? toUiWorktree(row);
    entry.detail = entry.worktree.unavailableReason || "Created outside Canopy";

    return { entry, settings };
  }

  if (row.removed_at) {
    entry.removed = true;
    entry.detail = "This worktree was removed. Thread history stays available.";
  } else if (!online) entry.detail = "Worker offline; cleanup will retry when it reconnects";
  else if (!connection?.hello.capabilities.includes("worktree_lifecycle"))
    entry.detail = "Update this worker to manage worktrees";
  else if (row.removal_token) entry.detail = "Cleanup in progress; waiting for the worker's result";
  else {
    const result = await coreWorkerQuery(
      core,
      row.worker_id,
      {
        case: "scanWorktrees",
        value: {
          targets: [worktreeTarget(row, settings)],
          fetch,
          background: currentProcessPriority() === "background",
        },
      },
      60_000,
    );

    entry.status = result.worktreeStatuses.find((s) => s.id === row.id);
    entry.detail = entry.status?.detail || (entry.status ? "" : "Worker did not return a worktree status");

    if (
      entry.status &&
      !entry.detail &&
      !entry.status.merged &&
      (await mergedProof(core, row, entry.status.githubRepository, entry.status.branch, entry.status.headCommit))
    ) {
      entry.status.merged = true;
      entry.status.unpushed = false;
    }
  }

  const status = entry.status;

  if (!entry.detail && status) {
    entry.lastActivityAt = timestampFromDate(lastActivity(row, status));
    entry.confirmationRequired = Boolean(status.dirtyFiles || status.unpushed);
    entry.wouldRemove =
      !row.busy &&
      (closedThreadCleanup(row, settings) || !entry.confirmationRequired) &&
      matchesCleanup(row, status, settings);
    entry.detail = row.busy
      ? "A thread is still using this worktree"
      : row.archive_grace_period
        ? cleanupReason(row, status, settings)
        : entry.confirmationRequired && !entry.wouldRemove
          ? settings.keepLocalChanges
            ? "Kept: local changes or unpushed commits"
            : "Explicit confirmation required for local changes or unpushed commits"
          : cleanupReason(row, status, settings);
  }

  return { entry, settings };
}

export async function removeEntry(
  core: GatewayCore,
  row: WorktreeLifecycleRow,
  status: WorktreeStatus,
  settings: ui.WorktreeSettings,
  confirmation = false,
  expectedHead = status.headCommit,
  policy = false,
) {
  if (row.external) throw new InvalidError("Canopy cannot remove worktrees created outside Canopy.");

  if (row.busy) throw new InvalidError("a thread is still using this worktree");

  const closedCleanup = policy && closedThreadCleanup(row, settings);
  confirmation ||= closedCleanup;

  if ((status.dirtyFiles || status.unpushed) && !confirmation)
    throw new InvalidError("Local changes or unpushed commits require explicit confirmation");

  if (expectedHead !== status.headCommit) throw new InvalidError("The worktree changed; refresh before removing it");
  const reason = cleanupReason(row, status, settings);

  const confirmedPr =
    status.githubRepository &&
    (await mergedProof(core, row, status.githubRepository, status.branch, status.headCommit));

  const trackBranch = Boolean(
    settings.deleteLocalBranch &&
    !row.detached_commit &&
    row.branch &&
    core.link.connections.get(row.worker_id)?.hello.capabilities.includes("archived_branch_cleanup"),
  );

  const command = create(CommandSchema, {
    commandId: Bun.randomUUIDv7(),
    kind: {
      case: "removeWorktree",
      value: {
        target: worktreeTarget(row, settings, status, Boolean(confirmedPr)),
        confirmLocalChanges: confirmation,
        expectedHeadCommit: expectedHead,
        deleteArchivedBranch:
          trackBranch &&
          row.all_archived &&
          status.merged &&
          !status.dirtyFiles &&
          !status.unpushed &&
          status.branch === row.branch,
        trackBranchForCleanup: trackBranch,
        requireMerged: policy && reason === "Branch merged into the default or base branch",
        requireUnchanged: policy && reason === "Unchanged since creation",
      },
    },
  });

  const current = await coreRun(core, (s) =>
    s.reserveWorktreeRemoval(
      core[coreState].options.userId,
      row,
      command,
      policy
        ? (state) => matchesCleanup(state, status, settings) && (!closedCleanup || closedThreadCleanup(state, settings))
        : undefined,
    ),
  );

  return deliverRemoval(core, current, fromBinary(CommandSchema, current.removal_command));
}

export function pendingRemoval(row: WorktreeLifecycleRow): Command | undefined {
  return row.removal_command ? fromBinary(CommandSchema, row.removal_command) : undefined;
}
