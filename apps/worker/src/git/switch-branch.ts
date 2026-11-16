import type { SwitchThreadBranch } from "@canopy/contracts";
import { freshGit, git, gitOk, GitError, validBranch, recoverGit } from "./git.ts";
import { readHead } from "./heads.ts";
import { clearBranchStash, restoreBranchStash, saveBranchStash } from "./branch-stash.ts";

function switchError(stderr: string): GitError {
  if (/already (?:checked out|used by worktree)/i.test(stderr))
    return new GitError("BRANCH_IN_USE", "This branch is checked out in another worktree. Choose another branch.");

  if (/branch named .+ already exists/i.test(stderr))
    return new GitError(
      "BRANCH_EXISTS",
      "A local branch with this name already exists. Select it under Local branches.",
    );

  return new GitError(
    "SWITCH_FAILED",
    "Git could not switch branches. Check this directory in your terminal and try again.",
  );
}

/** Exact ref selection and fresh status; dirty changes are saved only with explicit consent. */
export async function switchBranch(request: SwitchThreadBranch) {
  return freshGit(async () => {
    const { cwd, branch, remote } = request;

    if (!(await validBranch(cwd, branch))) throw new GitError("INVALID_BRANCH", "Choose an existing branch.");
    const ref = `refs/${remote ? "remotes" : "heads"}/${branch}`;

    if (!(await git(cwd, ["show-ref", "--verify", "--quiet", ref])).ok)
      throw new GitError("BRANCH_NOT_FOUND", "This branch no longer exists. Refresh the branch list.");
    let destination = branch;
    let args = ["switch", "--no-overwrite-ignore", "--no-guess", branch];

    if (remote) {
      const remotes = (await gitOk(cwd, ["remote"], "GIT_FAILED")).trim().split("\n");
      const name = remotes.sort((a, b) => b.length - a.length).find((name) => branch.startsWith(`${name}/`));
      const local = name ? branch.slice(name.length + 1) : "";

      if (!(await validBranch(cwd, local))) throw new GitError("INVALID_BRANCH", "Choose a local or remote branch.");
      destination = local;
      args = ["switch", "--no-overwrite-ignore", "--track", "-c", local, ref];
    }

    const status = await gitOk(
      cwd,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      "STATUS_FAILED",
    );

    if (status && !request.stashChanges)
      throw new GitError(
        "DIRTY_CHECKOUT",
        "This directory has uncommitted changes. Commit or stash them before switching branches.",
      );

    if (status.split("\0").some((line) => /^[12] /.test(line) && /^S(?!\.\.\.)/.test(line.split(" ")[2] ?? "")))
      throw new GitError(
        "DIRTY_SUBMODULE",
        "This directory has changed submodules. Commit or restore them before switching branches.",
      );

    if (status.split("\0").some((line) => line.startsWith("u ")))
      throw new GitError("UNMERGED_CHECKOUT", "Resolve existing conflicts before switching branches.");

    const intentToAdd = await gitOk(cwd, ["diff", "--name-only", "--diff-filter=A", "-z"], "STATUS_FAILED");

    if (intentToAdd)
      throw new GitError(
        "INTENT_TO_ADD",
        "This directory has intent-to-add files. Stage or unstage them before switching branches.",
      );

    const initialHead = await readHead(cwd);

    if (!initialHead)
      throw new GitError("HEAD_UNAVAILABLE", "Could not read the current branch. Refresh and try again.");
    const stash = status ? await saveBranchStash(cwd) : undefined;
    let branchSwitchWarning = "";
    let switchAttempted = false;

    try {
      if (stash) await clearBranchStash(cwd, stash);
      switchAttempted = true;
      const result = await git(cwd, args);

      if (!result.ok) throw switchError(result.stderr);
    } catch (error) {
      const actual = await recoverGit(() => readHead(cwd));

      if (switchAttempted && initialHead.branch !== destination && actual?.branch === destination) {
        branchSwitchWarning =
          "Branch switched, but Git did not finish cleanly. Check this directory before continuing.";
      } else {
        const detail = stash ? await restoreBranchStash(cwd, stash) : "";

        if (detail)
          throw new GitError(
            error instanceof GitError ? error.code : "SWITCH_FAILED",
            `${error instanceof Error ? error.message : "Could not switch branches."} ${detail}`,
          );
        throw error;
      }
    }

    if (stash)
      branchSwitchWarning = [branchSwitchWarning, await restoreBranchStash(cwd, stash)].filter(Boolean).join(" ");
    const head = await recoverGit(() => readHead(cwd));

    if (!head)
      throw new GitError(
        "HEAD_UNAVAILABLE",
        `Could not read the current branch. Refresh the thread. ${branchSwitchWarning}`.trim(),
      );

    return { switchedHead: { ...head, threadIds: request.threadId ? [request.threadId] : [] }, branchSwitchWarning };
  });
}
