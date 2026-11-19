import { RemoveWorktreeSchema, type RemoveWorktree, type WorktreeTarget } from "@canopy/contracts";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GitError, gitOk } from "./git.ts";
import { deleteArchivedBranch, repositoryIdentity, type BranchCleanupResult } from "./delete-archived-branch.ts";
import { checkedWorktree, scanWorktree } from "./worktree-status.ts";

/** Recheck before removal; the gateway grants disposal manually or through a closed-thread policy. */
export async function removeWorktree(
  managedRoots: readonly string[],
  request: RemoveWorktree,
  idle: () => Promise<void>,
  receipt: string,
  current = () => true,
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

  const canClean = Boolean(
    target.branch && !status.dirtyFiles && (request.deleteArchivedBranch || request.trackBranchForCleanup),
  );

  const identity = canClean ? await repositoryIdentity(repo).catch(() => "") : "";
  await idle();
  mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
  // Intent survives a crash between git's removal and the command journal's success record.
  writeFileSync(receipt, toBinary(RemoveWorktreeSchema, request), { mode: 0o600, flush: true });
  await gitOk(
    repo,
    ["worktree", "remove", ...(request.confirmLocalChanges && status.dirtyFiles ? ["--force"] : []), "--", path],
    "REMOVE_FAILED",
  );

  // Git rechecked clean worktrees during the unforced removal. Save that result before any later
  // fetch/merge lookup so a process restart during the lookup can resume from a clean removal.
  const saved = recordOutcome(receipt, identity || "removed");
  const candidate = Boolean(request.trackBranchForCleanup && identity && saved);

  const result =
    saved && identity && request.deleteArchivedBranch
      ? await cleanupWithReceipt(receipt, target, status.headCommit, identity, current)
      : "retry";

  return {
    worktreeBranchDeleted: result === "deleted",
    worktreeBranchCleanupCandidate: candidate && result === "retry",
  };
}

function recordOutcome(receipt: string, outcome: string) {
  try {
    writeFileSync(`${receipt}.outcome`, outcome, { mode: 0o600, flush: true });

    return true;
  } catch {
    // Branch bookkeeping cannot invalidate Git's successful removal.
    return false;
  }
}

function readOutcome(receipt: string) {
  return existsSync(`${receipt}.outcome`) ? readFileSync(`${receipt}.outcome`, "utf8") : "";
}

/** Consume permission while Git holds the exact tip. After an interrupted commit a receipt can
 * acknowledge a terminal keep, but can never authorize deleting a newly recreated branch.
 */
async function cleanupWithReceipt(
  receipt: string,
  target: WorktreeTarget,
  head: string,
  identity: string,
  current: () => boolean,
): Promise<BranchCleanupResult> {
  const consume = () => readOutcome(receipt) === identity && recordOutcome(receipt, "removed");
  const result = await deleteArchivedBranch(target.repoRoot, target.branch, head, target, identity, current, consume);

  if (result === "deleted") {
    recordOutcome(receipt, "deleted");

    return result;
  }

  const outcome = readOutcome(receipt);

  if (outcome === "deleted") return "deleted";

  if (outcome !== identity) return "keep";

  if (result === "keep") consume();

  return result;
}

export async function cleanupRemovedBranch(
  receipt: string,
  target: WorktreeTarget,
  head: string,
  current = () => true,
): Promise<BranchCleanupResult> {
  if (!existsSync(receipt)) return "keep";
  const original = fromBinary(RemoveWorktreeSchema, readFileSync(receipt));
  const previous = original.target;

  if (
    !original.trackBranchForCleanup ||
    !previous ||
    original.expectedHeadCommit !== head ||
    previous.id !== target.id ||
    previous.path !== target.path ||
    previous.repoRoot !== target.repoRoot ||
    previous.branch !== target.branch ||
    previous.baseRef !== target.baseRef ||
    previous.baseCommit !== target.baseCommit ||
    previous.remote !== target.remote ||
    previous.location !== target.location
  )
    return "keep";
  const identity = readOutcome(receipt);

  if (identity === "deleted") return "deleted";

  if (!identity || identity === "removed") return "keep";

  if (existsSync(target.path)) return "retry";
  const actual = await repositoryIdentity(target.repoRoot).catch(() => undefined);

  if (!actual) return "retry";

  if (actual !== identity) {
    recordOutcome(receipt, "removed");

    return "keep";
  }

  return cleanupWithReceipt(receipt, target, head, identity, current);
}

/** A replay can revoke branch permissions while the exact checkout removal stays authorized. */
export async function recoverRemoval(receipt: string, request: RemoveWorktree) {
  const target = request.target;

  if (!target || !existsSync(receipt)) return;
  const original = fromBinary(RemoveWorktreeSchema, readFileSync(receipt));

  for (const key of ["deleteBranch", "deleteArchivedBranch", "trackBranchForCleanup"] as const) {
    if (!request[key]) original[key] = false;
  }

  if (
    !Buffer.from(toBinary(RemoveWorktreeSchema, original)).equals(Buffer.from(toBinary(RemoveWorktreeSchema, request)))
  )
    throw new GitError("INVALID_COMMAND", "removal command changed since its first attempt");
  const outcome = readOutcome(receipt);

  if (!outcome) {
    if (existsSync(target.path)) return;
    const listed = await gitOk(target.repoRoot, ["worktree", "list", "--porcelain", "-z"], "WORKTREE_NOT_FOUND");

    if (listed.split("\0").includes(`worktree ${target.path}`)) return;
  }

  return {
    worktreeBranchDeleted: outcome === "deleted",
    worktreeBranchCleanupCandidate: Boolean(request.trackBranchForCleanup && outcome.startsWith("[")),
  };
}
