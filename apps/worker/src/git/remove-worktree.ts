import { RemoveWorktreeSchema, type RemoveWorktree } from "@canopy/contracts";
import { toBinary } from "@bufbuild/protobuf";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { git, GitError, gitOk, validBranch } from "./git.ts";
import { checkedWorktree, scanWorktree } from "./worktree-status.ts";

/** Recheck immediately before removal. Only a manual confirmation permits discarding local files. */
export async function removeWorktree(
  managedRoots: readonly string[],
  request: RemoveWorktree,
  idle: () => Promise<void>,
  receipt: string,
) {
  const target = request.target;

  if (!target) throw new GitError("INVALID_COMMAND", "worktree target missing");
  const status = await scanWorktree(managedRoots, target, true);

  if (status.headCommit !== request.expectedHeadCommit)
    throw new GitError("WORKTREE_CHANGED", "the worktree changed; refresh before removing it");

  if ((status.dirtyFiles || status.unpushed) && !request.confirmLocalChanges)
    throw new GitError("CONFIRMATION_REQUIRED", "local changes or unpushed commits require explicit confirmation");

  if (request.requireMerged && !status.merged) throw new GitError("NOT_MERGED", "the branch is no longer merged");

  if (request.requireUnchanged && !status.unchanged) throw new GitError("WORKTREE_CHANGED", "the worktree changed");
  const { path, repo } = await checkedWorktree(managedRoots, target);
  await idle();
  mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
  // Intent survives a crash between git's removal and the command journal's success record.
  writeFileSync(receipt, toBinary(RemoveWorktreeSchema, request), { mode: 0o600, flush: true });
  await gitOk(
    repo,
    ["worktree", "remove", ...(request.confirmLocalChanges && status.dirtyFiles ? ["--force"] : []), "--", path],
    "REMOVE_FAILED",
  );

  // An unpushed branch is the recovery path after a confirmed removal; always retain it.
  if (request.deleteBranch && !status.unpushed && !status.dirtyFiles && (status.merged || status.unchanged)) {
    return deleteSafeBranch(repo, target.branch, status.headCommit);
  }

  return false;
}

/** Branch cleanup cannot turn a successful worktree removal into an unaudited failure. */
async function deleteSafeBranch(repo: string, branch: string, head: string): Promise<boolean> {
  try {
    if (!(await validBranch(repo, branch))) return false;
    const current = await git(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}`]);

    // Git also refuses deleting a branch checked out in another worktree.
    return current.ok && current.stdout.trim() === head && (await git(repo, ["branch", "-d", "--", branch])).ok;
  } catch {
    return false;
  }
}

/** Recover only an exact, previously validated intent whose registered checkout has gone. Keep the branch. */
export async function recoverRemoval(receipt: string, request: RemoveWorktree): Promise<boolean> {
  const target = request.target;

  if (!target || !existsSync(receipt) || existsSync(target.path)) return false;

  if (!readFileSync(receipt).equals(Buffer.from(toBinary(RemoveWorktreeSchema, request))))
    throw new GitError("INVALID_COMMAND", "removal command changed since its first attempt");
  const listed = await gitOk(target.repoRoot, ["worktree", "list", "--porcelain", "-z"], "WORKTREE_NOT_FOUND");

  return !listed.split("\0").includes(`worktree ${target.path}`);
}
