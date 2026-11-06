import type { GitHeads } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreBroadcastThread, coreLog, coreRun } from "../core/core-broadcast.ts";
import { describeError } from "../core/core-context.ts";
import type { GitHeadValue } from "../store/worktrees.ts";

/**
 * The live branch of the threads' checkouts (docs/worktrees.md, "Bieżąca gałąź"). The worker reports it; the
 * gateway keeps it only for the worker's own threads and broadcasts the threads whose branch changed.
 */

const MAX_HEADS = 200;
const MAX_THREADS = 500;

/** What git allows in a branch name, bounded; anything else is not a branch the UI can show. */
function parsedHead(branch: string, detachedCommit: string): GitHeadValue | undefined {
  if (branch) {
    // oxlint-disable-next-line no-control-regex -- git forbids control characters in ref names; reject them here too.
    return branch.length <= 255 && !/[\u0000-\u001f\u007f]/.test(branch) ? { branch, detachedCommit: "" } : undefined;
  }

  return /^[0-9a-f]{4,64}$/.test(detachedCommit) ? { branch: "", detachedCommit } : undefined;
}

export async function coreGitHeads(hostContext: GatewayCore, workerId: string, report: GitHeads): Promise<void> {
  const changed = new Set<string>();

  for (const reported of report.heads.slice(0, MAX_HEADS)) {
    const head = parsedHead(reported.branch, reported.detachedCommit);

    if (!head) continue;

    try {
      const threads = await coreRun(hostContext, (s) =>
        s.saveGitHead(workerId, reported.threadIds.slice(0, MAX_THREADS), head),
      );

      for (const id of threads) changed.add(id);
    } catch (cause) {
      coreLog(hostContext, `git head of worker ${workerId} not stored: ${describeError(cause)}`);
    }
  }

  for (const id of changed) await coreBroadcastThread(hostContext, id);
}
