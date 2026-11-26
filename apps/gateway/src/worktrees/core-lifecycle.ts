import { ownerModuleEnabled } from "../store/module-access.ts";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreRun } from "../core/core-broadcast.ts";
import type { GatewayCore } from "../core/core.ts";
import { deliverRemoval, pendingRemoval, removeEntry, scanEntry, worktreeTarget } from "./lifecycle.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { cleanupRemovedBranches } from "./removed-branch-cleanup.ts";
import { appendDiscovered } from "./discovery.ts";
import { toUiWorktree } from "./core-worktrees.ts";

export interface CoreWorktreeLifecycleMethods {
  listWorktrees(request: ui.ListWorktreesRequest): Promise<ui.ListWorktreesResponse>;
  cleanupWorktrees(request: ui.CleanupWorktreesRequest, scheduledStop?: AbortSignal): Promise<ui.ListWorktreesResponse>;
  removeWorktree(request: ui.RemoveWorktreeRequest): Promise<ui.WorktreeEntry>;
  revealWorktree(request: ui.RemoveWorktreeRequest): Promise<void>;
}

export const coreWorktreeLifecycleMethods: CoreWorktreeLifecycleMethods = {
  async revealWorktree(this: GatewayCore, request) {
    const rows = await coreRun(this, (s) =>
      s.worktreeInventory(this[coreState].options.userId, "", "", request.worktreeId),
    );

    const row = rows[0];

    if (!row) throw new InvalidError("worktree not found");

    if (row.external) throw new InvalidError("Copy the path to open this external worktree.");
    const { entry, settings } = await scanEntry(this, row, false);

    if (!entry.status || entry.status.detail) throw new InvalidError(entry.detail);
    await coreWorkerQuery(
      this,
      row.worker_id,
      { case: "revealWorktree", value: worktreeTarget(row, settings) },
      20_000,
    );
  },
  async listWorktrees(this: GatewayCore, request) {
    const rows = await coreRun(this, (s) =>
      s.worktreeInventory(this[coreState].options.userId, request.projectId, request.workerId, request.worktreeId),
    );

    const entries = [];

    for (const row of rows) {
      try {
        entries.push((await scanEntry(this, row, false)).entry);
      } catch {
        entries.push(
          create(ui.WorktreeEntrySchema, {
            detail: "Status unavailable; refresh to retry",
            worktree: toUiWorktree(row),
          }),
        );
      }
    }

    if (!request.worktreeId) {
      await appendDiscovered(this, entries, rows, request.projectId, request.workerId, true);
    }

    return create(ui.ListWorktreesResponseSchema, { entries });
  },

  async cleanupWorktrees(this: GatewayCore, request, scheduledStop) {
    const { actions, options } = this[coreState];
    const enabled = () => actions.run(ownerModuleEnabled(options.userId, "threads"));

    if (!(await enabled())) return create(ui.ListWorktreesResponseSchema);

    const rows = await coreRun(this, (s) =>
      s.worktreeInventory(this[coreState].options.userId, request.projectId, request.workerId),
    );

    if (!request.dryRun) await cleanupRemovedBranches(this, request.projectId, request.workerId, scheduledStop);

    const entries = [];

    for (const row of rows) {
      scheduledStop?.throwIfAborted();

      // Only the manual inventory shows checkouts that Canopy cannot remove.
      if (scheduledStop && row.external) continue;

      try {
        if (!(await enabled())) return create(ui.ListWorktreesResponseSchema, { entries });
        scheduledStop?.throwIfAborted();
        const pending = pendingRemoval(row);

        if (!request.dryRun && pending && this.link.connections.get(row.worker_id)?.isOpen) {
          const branchDeleted = await deliverRemoval(this, row, pending);
          entries.push(
            create(ui.WorktreeEntrySchema, {
              worktree: { id: row.id, branch: row.branch, path: row.path },
              removed: true,
              branchDeleted,
              detail: "Removed",
            }),
          );
          continue;
        }

        const { entry, settings } = await scanEntry(this, row, true, scheduledStop);
        scheduledStop?.throwIfAborted();

        if (!request.dryRun && entry.wouldRemove && entry.status) {
          entry.branchDeleted = await removeEntry(
            this,
            row,
            entry.status,
            settings,
            false,
            entry.status.headCommit,
            true,
            scheduledStop,
          );
          entry.removed = true;
          entry.detail = "Removed";
        }

        entries.push(entry);
      } catch (error) {
        entries.push(
          create(ui.WorktreeEntrySchema, {
            worktree: toUiWorktree(row),
            detail: error instanceof Error ? error.message : "Cleanup failed; will retry later",
          }),
        );
      }
    }

    if (!scheduledStop && (await enabled()))
      await appendDiscovered(this, entries, rows, request.projectId, request.workerId);

    return create(ui.ListWorktreesResponseSchema, { entries });
  },

  async removeWorktree(this: GatewayCore, request) {
    const rows = await coreRun(this, (s) =>
      s.worktreeInventory(this[coreState].options.userId, "", "", request.worktreeId),
    );

    const row = rows[0];

    if (!row) throw new InvalidError("worktree not found");

    if (row.external) throw new InvalidError("Canopy cannot remove worktrees created outside Canopy.");
    const { entry, settings } = await scanEntry(this, row, true);

    if (!entry.status || entry.status.detail) throw new InvalidError(entry.detail);
    entry.branchDeleted = await removeEntry(
      this,
      row,
      entry.status,
      settings,
      request.confirmLocalChanges,
      request.expectedHeadCommit,
    );
    entry.removed = true;
    entry.detail = "Removed";

    return entry;
  },
};
