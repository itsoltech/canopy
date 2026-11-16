import { git, gitOk, validBranch } from "./git.ts";

/** Select only origin's configured upstream, otherwise the current branch's exact name. */
export async function statusTarget(cwd: string) {
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  const hasOrigin = (await gitOk(cwd, ["remote"], "GIT_FAILED")).split("\n").includes("origin");
  const committed = (await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).ok;
  let pullBranch = branch;
  let reason = "";

  if (!branch) reason = "This checkout has a detached HEAD. Switch to a branch before pulling.";
  else if (!committed) reason = "Create the first commit before pulling.";
  else if (!hasOrigin) reason = "This repository has no origin remote. Add origin before pulling.";
  else {
    const remote = await git(cwd, ["config", "--get", `branch.${branch}.remote`]);

    if (remote.stdout.trim() === "origin") {
      const merges = (await git(cwd, ["config", "--get-all", `branch.${branch}.merge`])).stdout.trim().split("\n");
      const merge = merges[0] ?? "";
      pullBranch = merge.startsWith("refs/heads/") ? merge.slice(11) : "";

      if (merges.length !== 1 || !(await validBranch(cwd, pullBranch))) {
        reason = "This branch has no valid origin upstream. Configure its origin tracking branch before pulling.";
        pullBranch = "";
      }
    }

    if (!reason && !(await validBranch(cwd, pullBranch))) reason = "This branch cannot be pulled from origin.";
  }

  return { branch, hasOrigin, committed, pullBranch, reason };
}
