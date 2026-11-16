import type { ThreadGitRequest } from "@canopy/contracts";
import { devNull } from "node:os";
import { boundedGit, FETCH_TIMEOUT_MS, freshGit, git, gitOk, GitError } from "./git.ts";
import { readHead } from "./heads.ts";
import { statusTarget } from "./status-target.ts";
import { threadGitStatus } from "./thread-status.ts";
import type { ThreadGitStatus } from "@canopy/contracts";

/** Explicit origin branch fetch, then fast-forward only; no fallback, rebase, stash, hooks or ignored overwrite. */
export async function pullOrigin(
  request: ThreadGitRequest,
  readStatus: () => Promise<ThreadGitStatus> = () => threadGitStatus(request.cwd),
) {
  return freshGit(async () => {
    const { cwd } = request;
    const target = await pullable(cwd);
    const config = ["-c", `core.hooksPath=${devNull}`, "-c", "submodule.recurse=false", "-c", "gc.auto=0"];

    const ref = `refs/canopy/pull/${Bun.randomUUIDv7()}`;
    let commit: string;

    try {
      const fetched = await git(
        cwd,
        [
          ...config,
          "fetch",
          "--no-write-fetch-head",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-auto-maintenance",
          "--",
          "origin",
          `refs/heads/${target.pullBranch}:${ref}`,
        ],
        FETCH_TIMEOUT_MS,
      );

      if (!fetched.ok) {
        if (/couldn't find remote ref/i.test(fetched.stderr))
          throw new GitError(
            "ORIGIN_BRANCH_MISSING",
            `Origin has no branch named ${target.pullBranch}. Push it before pulling.`,
          );
        throw new GitError(
          "FETCH_FAILED",
          "Could not fetch from origin. Check your Git access and connection, then try again.",
        );
      }

      commit = (await gitOk(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], "FETCH_FAILED")).trim();
    } finally {
      await boundedGit(BigInt(Date.now() + 5_000), () =>
        gitOk(cwd, [...config, "update-ref", "-d", ref], "REF_CLEANUP_FAILED", 5_000),
      );
    }

    const current = await pullable(cwd);

    if (current.branch !== target.branch || current.pullBranch !== target.pullBranch)
      throw new GitError("CHECKOUT_CHANGED", "The branch changed while fetching. Refresh the thread before pulling.");

    const merged = await git(cwd, [
      ...config,
      "merge",
      "--ff-only",
      "--no-edit",
      "--no-autostash",
      "--no-overwrite-ignore",
      commit,
    ]);

    if (!merged.ok)
      throw new GitError(
        "PULL_FAILED",
        "Could not fast-forward this branch. Resolve diverged history or local changes in your terminal.",
      );
    const head = await readHead(cwd);

    if (!head?.branch) throw new GitError("HEAD_UNAVAILABLE", "Could not read the current branch. Refresh the thread.");

    return { switchedHead: { ...head, threadIds: [request.threadId] }, threadGitStatus: await readStatus() };
  });
}

async function pullable(cwd: string) {
  const target = await statusTarget(cwd);

  if (target.reason) throw new GitError("PULL_UNAVAILABLE", target.reason);
  const status = await gitOk(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], "STATUS_FAILED");

  if (status)
    throw new GitError(
      "DIRTY_CHECKOUT",
      "This directory has uncommitted changes. Commit or discard them before pulling.",
    );

  return target;
}
