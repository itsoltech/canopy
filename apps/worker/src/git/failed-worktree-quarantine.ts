import { mkdtempSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { GitError } from "./git.ts";
import type { CheckoutPlan } from "./worktree-rollback.ts";
import {
  directoryStillMatches,
  physicalDirectory,
  relocatedDirectory,
  removeInspectedDirectory,
  statPath,
} from "./worktree-rollback-files.ts";

interface StagingDirectory {
  readonly root: string;
  readonly target: string;
}

function prepare(parent: string): StagingDirectory {
  if (!physicalDirectory(parent)) throw new Error("Staging parent changed");
  const root = mkdtempSync(join(parent, ".canopy-cleanup-"));

  return { root, target: join(root, "remaining") };
}

/** Move both candidates off the public paths and recheck them before unlinking any files.
 * Any staged data that cannot be verified or removed stays available for local recovery.
 */
export function removeVerifiedCheckout({
  checkout,
  metadata,
  common,
  plan,
}: {
  checkout: string;
  metadata: string;
  common: string;
  plan: CheckoutPlan;
}): void {
  const staged: StagingDirectory[] = [];

  try {
    if (!directoryStillMatches(checkout, plan.checkout) || !directoryStillMatches(metadata, plan.admin))
      throw new Error("Worktree changed before staging");

    const folder = prepare(dirname(checkout));
    staged.push(folder);
    const admin = prepare(common);
    staged.push(admin);
    renameSync(checkout, folder.target);

    if (statPath(checkout) || !directoryStillMatches(metadata, plan.admin))
      throw new Error("Worktree changed during staging");
    renameSync(metadata, admin.target);

    const movedFolder = relocatedDirectory(folder.target, plan.checkout);
    const movedAdmin = relocatedDirectory(admin.target, plan.admin);

    if (!movedFolder || !movedAdmin || statPath(checkout) || statPath(metadata))
      throw new Error("Staged worktree changed");

    if (!removeInspectedDirectory(folder.target, movedFolder) || !removeInspectedDirectory(admin.target, movedAdmin))
      throw new Error("Staged worktree changed during removal");
  } catch {
    const remaining = staged.flatMap(({ target }) => (statPath(target) ? [target] : []));

    throw new GitError(
      "WORKTREE_CLEANUP_BLOCKED",
      remaining.length
        ? `Cleanup stopped. Check the files retained on the worker in ${remaining.join(" and ")}.`
        : "Cleanup stopped because the worktree changed or was in use. Refresh and check its status.",
    );
  } finally {
    for (const { root } of staged) {
      try {
        rmdirSync(root);
      } catch {
        // rmdir leaves any staged contents intact.
      }
    }
  }
}
