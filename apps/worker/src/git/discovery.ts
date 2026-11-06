import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { create } from "@bufbuild/protobuf";
import { GitWorktreeSchema, type GitWorktree } from "@canopy/contracts";
import { freshGit, gitOk, GitError } from "./git.ts";

const TIMEOUT_MS = 3_000;
const CACHE_MS = 2_000;

/** Preserve registry spelling (a configured root can be a symlink) without treating it as another worktree. */
export function withKnownPaths(trees: readonly GitWorktree[], paths: readonly string[]): GitWorktree[] {
  const aliases = new Map<string, string[]>();

  for (const path of paths) {
    try {
      const canonical = realpathSync(path);
      const known = aliases.get(canonical) ?? [];
      known.push(path);
      aliases.set(canonical, known);
    } catch {
      // A missing registered directory is shown by the gateway with its stored spelling.
    }
  }

  return trees.map((tree) => create(GitWorktreeSchema, { ...tree, aliases: aliases.get(tree.path) ?? [] }));
}

/** -z preserves spaces, quotes, backslashes and newlines in paths without Git's quoted-path syntax. */
function parseWorktrees(output: string): GitWorktree[] {
  return output.split("\0\0").flatMap((record) => {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);

    if (!path || fields.includes("bare") || !isAbsolute(path)) return [];

    return [
      create(GitWorktreeSchema, {
        path,
        branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18) ?? "",
        headCommit: fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "",
        detached: fields.includes("detached"),
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      }),
    ];
  });
}

/** Per WorkerHost, bounded and short-lived; failed reads never poison the cache. */
export class WorktreeDiscovery {
  readonly #cache = new Map<
    string,
    { until: number; result: Promise<{ repoRoot: string; worktrees: GitWorktree[] }> }
  >();

  clear(): void {
    this.#cache.clear();
  }

  list(repoPath: string, fresh = false): Promise<{ repoRoot: string; worktrees: GitWorktree[] }> {
    const key = realpathSync(repoPath);
    const cached = this.#cache.get(key);

    if (!fresh && cached && cached.until > Date.now()) return cached.result;
    const result = freshGit(() => this.#read(key));

    if (this.#cache.size >= 64) this.#cache.clear();
    this.#cache.set(key, { until: Date.now() + CACHE_MS, result });
    void result.catch(() => {
      if (this.#cache.get(key)?.result === result) this.#cache.delete(key);
    });

    return result;
  }

  async #read(repo: string): Promise<{ repoRoot: string; worktrees: GitWorktree[] }> {
    const deadline = Date.now() + TIMEOUT_MS;

    const read = (cwd: string, args: string[]) => {
      const remaining = deadline - Date.now();

      if (remaining <= 0)
        throw new GitError("GIT_TIMEOUT", "Worktree discovery timed out. Reopen the picker to retry.");

      return gitOk(cwd, args, "WORKTREE_DISCOVERY_FAILED", remaining);
    };

    const root = realpathSync((await read(repo, ["rev-parse", "--show-toplevel"])).trim());
    const common = realpathSync((await read(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const worktrees = parseWorktrees(await read(repo, ["worktree", "list", "--porcelain", "-z"]));

    for (const tree of worktrees) {
      let path: string;

      try {
        path = realpathSync(tree.path);
      } catch {
        tree.missing = true;
        tree.unavailableReason = tree.prunable ? "Prunable worktree · Directory missing" : "Directory missing";
        continue;
      }

      try {
        // A registered path may now point at a different repository or a subdirectory via a symlink.
        const top = realpathSync((await read(path, ["rev-parse", "--show-toplevel"])).trim());

        const actual = realpathSync(
          (await read(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
        );

        if (path !== top || actual !== common)
          tree.unavailableReason = "Directory no longer belongs to this repository";
        else tree.path = path;
      } catch {
        tree.unavailableReason = "Directory unavailable. Refresh to retry.";
      }

      if (tree.prunable) tree.unavailableReason = "Prunable worktree";
      else if (tree.locked) tree.unavailableReason = "Locked worktree";
    }

    return { repoRoot: root, worktrees };
  }
}
