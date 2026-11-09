import type { SwitchThreadBranch } from "@canopy/contracts";
import { freshGit, git, gitOk, GitError, validBranch } from "./git.ts";
import { readHead } from "./heads.ts";

/** Explicit selection only. No revision expressions, fetch, stash, force or ignored-file overwrite. */
export async function switchBranch(request: SwitchThreadBranch) {
  return freshGit(async () => {
    const { cwd, branch, remote } = request;

    if (!(await validBranch(cwd, branch))) throw new GitError("INVALID_BRANCH", "Choose an existing branch.");
    const ref = `refs/${remote ? "remotes" : "heads"}/${branch}`;

    if (!(await git(cwd, ["show-ref", "--verify", "--quiet", ref])).ok)
      throw new GitError("BRANCH_NOT_FOUND", "This branch no longer exists. Refresh the branch list.");
    const status = await gitOk(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"], "STATUS_FAILED");

    if (status.trim())
      throw new GitError(
        "DIRTY_CHECKOUT",
        "This directory has uncommitted changes. Commit or discard them before switching.",
      );

    let args = ["switch", "--no-overwrite-ignore", "--no-guess", branch];

    if (remote) {
      const remotes = (await gitOk(cwd, ["remote"], "GIT_FAILED")).trim().split("\n");
      const name = remotes.sort((a, b) => b.length - a.length).find((name) => branch.startsWith(`${name}/`));
      const local = name ? branch.slice(name.length + 1) : "";

      if (!(await validBranch(cwd, local))) throw new GitError("INVALID_BRANCH", "Choose a local or remote branch.");
      args = ["switch", "--no-overwrite-ignore", "--track", "-c", local, ref];
    }

    const switched = await git(cwd, args);

    if (!switched.ok) {
      if (/already (?:checked out|used by worktree)/i.test(switched.stderr))
        throw new GitError("BRANCH_IN_USE", "This branch is checked out in another worktree. Choose another branch.");

      if (/branch named .+ already exists/i.test(switched.stderr))
        throw new GitError(
          "BRANCH_EXISTS",
          "A local branch with this name already exists. Select it under Local branches.",
        );

      throw new GitError(
        "SWITCH_FAILED",
        "Git could not switch branches. Check this directory in your terminal and try again.",
      );
    }

    const head = await readHead(cwd);

    if (!head) throw new GitError("HEAD_UNAVAILABLE", "Could not read the current branch. Refresh the thread.");

    return { ...head, threadIds: [request.threadId] };
  });
}
