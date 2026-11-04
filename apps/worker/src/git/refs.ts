import { realpathSync } from "node:fs";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { GitRefSchema, GitRefsSchema } from "@canopy/contracts";
import { git } from "./git.ts";

export type GitRefsInit = MessageInitShape<typeof GitRefsSchema>;

type GitRefInit = MessageInitShape<typeof GitRefSchema>;

/** Branches listed for the ref picker (newest commit first). */
export const MAX_REFS = 500;

/** The work tree's top level, or undefined when the folder is not in a git work tree. */
export async function repoRoot(path: string): Promise<string | undefined> {
  const result = await git(path, ["rev-parse", "--show-toplevel"]);

  return result.ok ? realpathSync(result.stdout.trim()) : undefined;
}

async function line(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);

  return result.ok ? result.stdout.trim() : "";
}

/**
 * The repository's default branch: what `<remote>/HEAD` points at (as the local branch when one exists),
 * else main or master, else the current branch.
 */
export function defaultBranch(remoteHead: string, remote: string, refs: readonly GitRefInit[], current: string) {
  const local = new Set(refs.flatMap((r) => (r.remote ? [] : [r.name])));
  const all = new Set(refs.map((r) => r.name));

  if (remoteHead) {
    const name = remoteHead.slice(remote.length + 1);

    if (local.has(name)) return name;

    if (all.has(remoteHead)) return remoteHead;
  }

  return ["main", "master"].find((n) => local.has(n)) ?? current;
}

/** Local and remote branches, the current and default branch, and whether the checkout has changes. */
export async function listGitRefs(repoPath: string, remote = "origin"): Promise<GitRefsInit> {
  const root = await repoRoot(repoPath);

  if (!root) return { isRepo: false };

  const listed = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    `--count=${MAX_REFS + 20}`,
    "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(committerdate:unix)%00%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);

  const refs: GitRefInit[] = [];

  for (const row of listed.ok ? listed.stdout.split("\n") : []) {
    const [ref = "", commit = "", upstream = "", date = "", symref = ""] = row.split("\0");

    // refs/remotes/<remote>/HEAD is a pointer, not a branch.
    if (!ref || symref) continue;
    const isRemote = ref.startsWith("refs/remotes/");
    const seconds = Number(date);

    refs.push({
      name: ref.replace(/^refs\/(heads|remotes)\//, ""),
      remote: isRemote,
      commit,
      upstream,
      ...(Number.isFinite(seconds) && seconds > 0 && { committedAt: timestampFromMs(seconds * 1000) }),
    });
  }

  const [current, remoteHead, status] = await Promise.all([
    line(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    line(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]),
    git(root, ["status", "--porcelain"]),
  ]);

  return {
    isRepo: true,
    repoRoot: root,
    currentBranch: current,
    defaultBranch: defaultBranch(remoteHead, remote, refs, current),
    refs: refs.slice(0, MAX_REFS),
    dirty: status.ok && status.stdout.trim() !== "",
  };
}
