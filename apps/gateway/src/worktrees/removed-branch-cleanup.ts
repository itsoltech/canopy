import { fromBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { coreLog } from "../core/core-broadcast.ts";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import {
  finishRemovedBranch,
  lockRemovedBranch,
  removedBranchCandidates,
  reserveRemovedBranch,
  type RemovedBranchRow,
} from "../store/removed-branch-cleanup.ts";
import { coreWorktreeScope } from "./core-worktrees.ts";
import { mergedProof } from "./lifecycle.ts";

async function cleanupCandidate(core: GatewayCore, row: RemovedBranchRow) {
  const connection = core.link.connections.get(row.worker_id);

  if (!connection?.isOpen || !connection.hello.capabilities.includes("archived_branch_cleanup")) return;

  const { actions } = core[coreState];

  if (row.removal_token) {
    // Never authorize a second deletion on replay. The worker returns the existing result or journals a no-op.
    const result = await connection.sendCommand(
      { case: "cleanupRemovedBranch", value: { reconcileOnly: true } },
      90_000,
      row.removal_token,
    );

    await actions.run(finishRemovedBranch(row, row.removal_token, result));

    return;
  }

  const removal = fromBinary(CommandSchema, row.branch_cleanup_source);

  if (removal.kind.case !== "removeWorktree") return;
  const { expectedHeadCommit, target, trackBranchForCleanup } = removal.kind.value;

  if (!trackBranchForCleanup || !target?.branch || target.branch !== row.branch || target.id !== row.id) return;

  const enabled = async () =>
    (await coreWorktreeScope(core, row.project_id, row.worker_id)).effective.deleteLocalBranch;

  if (!(await enabled())) return;

  const verified =
    target.mergedPrRepository &&
    (await mergedProof(
      core,
      row.owner_user_id,
      row.worker_id,
      target.mergedPrRepository,
      target.branch,
      expectedHeadCommit,
    ));

  const attempt = Bun.randomUUIDv7();

  if (!(await actions.run(reserveRemovedBranch(row, attempt))).length) return;

  await actions.transaction(async () => {
    if (!(await actions.run(lockRemovedBranch(row, attempt))) || !(await enabled())) {
      await actions.run(finishRemovedBranch(row, attempt));

      return;
    }

    const result = await connection.sendCommand(
      {
        case: "cleanupRemovedBranch",
        value: {
          removalCommandId: removal.commandId,
          expectedHeadCommit,
          target: { ...target, mergedPrHead: verified ? expectedHeadCommit : "" },
        },
      },
      90_000,
      attempt,
    );

    await actions.run(finishRemovedBranch(row, attempt, result));
  });
}

export async function cleanupRemovedBranches(core: GatewayCore, projectId: string, workerId: string) {
  const { actions, options } = core[coreState];
  const candidates = await actions.run(removedBranchCandidates(options.userId, projectId, workerId));

  for (const row of candidates) {
    try {
      await cleanupCandidate(core, row);
    } catch {
      coreLog(core, `Deferred branch cleanup for worktree ${row.id} will retry later`);
    }
  }
}
