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
import { cleanupReason, lastActivity, matchesCleanup } from "./cleanup-policy.ts";

export function worktreeTarget(row: WorktreeLifecycleRow, settings: ui.WorktreeSettings, status?: WorktreeStatus) {
  return create(WorktreeTargetSchema, {
    id: row.id,
    path: row.path,
    repoRoot: row.repo_root,
    branch: row.branch,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    location: row.location,
    remote: settings.remote ?? "origin",
    mergedPrHead: status?.merged ? status.headCommit : "",
    mergedPrRepository: status?.merged ? status.githubRepository : "",
  });
}

/** Complete a reserved removal, preserving its command id across disconnects and gateway restarts. */
export async function deliverRemoval(core: GatewayCore, row: WorktreeLifecycleRow, command: Command) {
  const owner = core[coreState].options.userId;
  const connection = core.link.connections.get(row.worker_id);

  if (!connection?.isOpen) throw new UnavailableError("Worker offline; cleanup will retry when it reconnects");

  if (command.kind.case !== "removeWorktree") throw new InvalidError("Invalid worktree removal command");
  const result = await connection.sendCommand(command.kind, 90_000, command.commandId);

  if (!result.ok) {
    await coreRun(core, (s) => s.cancelWorktreeRemoval(owner, row.id, command.commandId));
    throw new InvalidError(result.errorMessage || "Worktree removal failed");
  }

  const threads = await coreRun(core, (s) =>
    s.finishWorktreeRemoval(owner, row.id, command.commandId, result.worktreeBranchDeleted),
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
      (await core.connectors.worktreeMerged(
        row.owner_user_id,
        row.worker_id,
        entry.status.githubRepository,
        entry.status.branch,
        entry.status.headCommit,
      ))
    ) {
      entry.status.merged = true;
      entry.status.unpushed = false;
    }
  }

  const status = entry.status;

  if (!entry.detail && status) {
    entry.lastActivityAt = timestampFromDate(lastActivity(row, status));
    entry.confirmationRequired = Boolean(status.dirtyFiles || status.unpushed);
    entry.wouldRemove = !row.busy && !entry.confirmationRequired && matchesCleanup(row, status, settings);
    entry.detail = row.busy
      ? "A thread is still using this worktree"
      : entry.confirmationRequired
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
  if (row.busy) throw new InvalidError("a thread is still using this worktree");

  if ((status.dirtyFiles || status.unpushed) && !confirmation)
    throw new InvalidError("Local changes or unpushed commits require explicit confirmation");

  if (expectedHead !== status.headCommit) throw new InvalidError("The worktree changed; refresh before removing it");
  const reason = cleanupReason(row, status, settings);

  const confirmedPr =
    status.githubRepository &&
    (await core.connectors.worktreeMerged(
      row.owner_user_id,
      row.worker_id,
      status.githubRepository,
      status.branch,
      status.headCommit,
    ));

  const command = create(CommandSchema, {
    commandId: Bun.randomUUIDv7(),
    kind: {
      case: "removeWorktree",
      value: {
        target: worktreeTarget(row, settings, confirmedPr ? status : undefined),
        confirmLocalChanges: confirmation,
        expectedHeadCommit: expectedHead,
        deleteBranch: settings.deleteLocalBranch ?? false,
        requireMerged: policy && reason === "Branch merged into the default or base branch",
        requireUnchanged: policy && reason === "Unchanged since creation",
      },
    },
  });

  const current = await coreRun(core, (s) => s.reserveWorktreeRemoval(core[coreState].options.userId, row.id, command));

  if (policy && !matchesCleanup(current, status, settings)) {
    await coreRun(core, (s) => s.cancelWorktreeRemoval(core[coreState].options.userId, row.id, command.commandId));
    throw new InvalidError("The cleanup policy no longer matches");
  }

  return deliverRemoval(core, row, command);
}

export function pendingRemoval(row: WorktreeLifecycleRow): Command | undefined {
  return row.removal_command ? fromBinary(CommandSchema, row.removal_command) : undefined;
}
