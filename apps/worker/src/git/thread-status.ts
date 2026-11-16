import { create } from "@bufbuild/protobuf";
import { ThreadGitStatusSchema } from "@canopy/contracts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk, GitError } from "./git.ts";
import { repoRoot } from "./refs.ts";
import { statusTarget } from "./status-target.ts";
import { diffLines, diffNames, newFileLines, STATUS_FILE_LIMIT } from "./status-counts.ts";

const DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=none"];

/** On-demand only. Process time/output and untracked content reads have independent bounds. */
export async function threadGitStatus(cwd: string) {
  const result = create(ThreadGitStatusSchema, { linesComplete: true });
  const root = await repoRoot(cwd);

  if (!root) {
    result.pullDisabledReason = "This directory is not a git checkout.";

    return result;
  }

  result.isRepo = true;
  const target = await statusTarget(root);
  result.branch = target.branch;
  result.hasOrigin = target.hasOrigin;
  result.pullBranch = target.pullBranch;
  result.pullDisabledReason = target.reason;

  const porcelain = await gitOk(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "STATUS_FAILED");
  const fields = porcelain.split("\0");
  const untracked: string[] = [];
  const conflicts = new Set<string>();
  const dirty = new Set<string>();

  for (let i = 0; i < fields.length - 1; i++) {
    const entry = fields[i] ?? "";
    const code = entry.slice(0, 2);
    const name = entry.slice(3);

    dirty.add(name);

    if (dirty.size > STATUS_FILE_LIMIT)
      throw new GitError(
        "STATUS_TOO_LARGE",
        "This checkout has too many changed files to summarize. Use your terminal.",
      );

    if (code === "??") untracked.push(name);
    else if (code.includes("U") || code === "AA" || code === "DD") conflicts.add(name);

    if (code.includes("R") || code.includes("C")) i++;
  }

  let files: Map<string, string>;

  if (target.committed) {
    files = diffNames(await gitOk(root, ["diff", "--name-status", "-z", ...DIFF_ARGS, "HEAD", "--"], "STATUS_FAILED"));
  } else {
    files = new Map();
    const tracked = await gitOk(root, ["ls-files", "--cached", "-z"], "STATUS_FAILED");

    const names = tracked.split("\0").filter(Boolean);

    if (names.length > STATUS_FILE_LIMIT)
      throw new GitError(
        "STATUS_TOO_LARGE",
        "This checkout has too many changed files to summarize. Use your terminal.",
      );

    for (const name of names) {
      if (
        await lstat(join(root, name)).then(
          () => true,
          () => false,
        )
      )
        files.set(name, "A");
    }
  }

  for (const name of dirty) if (!files.has(name)) files.set(name, "M");

  for (const name of untracked) files.set(name, "A");

  for (const name of conflicts) files.set(name, "U");

  if (files.size > STATUS_FILE_LIMIT)
    throw new GitError("STATUS_TOO_LARGE", "This checkout has too many changed files to summarize. Use your terminal.");
  result.files = files.size;

  for (const kind of files.values()) {
    if (kind === "A") result.added++;
    else if (kind === "D") result.deleted++;
    else if (kind === "R") result.renamed++;
    else if (kind === "U") result.conflicted++;
    else result.modified++;
  }

  if (target.committed) {
    const lines = await git(root, ["diff", "--numstat", "-z", ...DIFF_ARGS, "HEAD", "--"]);

    if (lines.ok) diffLines(lines.stdout, result);
    else result.linesComplete = false;
  }

  await newFileLines(root, target.committed ? untracked : [...files.keys()], result);

  if (conflicts.size) result.linesComplete = false;

  // Safety uses porcelain, including staged changes cancelled by an unstaged edit back to HEAD.
  if (!result.pullDisabledReason && porcelain)
    result.pullDisabledReason = "This directory has uncommitted changes. Commit or discard them before pulling.";

  return result;
}
