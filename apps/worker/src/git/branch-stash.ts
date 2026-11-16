import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk, GitError, recoverGit } from "./git.ts";

export interface BranchStash {
  readonly ref: string;
  readonly commit: string;
  readonly untracked: string[];
}

const identity = {
  GIT_AUTHOR_NAME: "Canopy",
  GIT_AUTHOR_EMAIL: "canopy@localhost",
  GIT_COMMITTER_NAME: "Canopy",
  GIT_COMMITTER_EMAIL: "canopy@localhost",
};

/** Build a normal stash object under a private ref; never pop a shared refs/stash entry by position. */
export async function saveBranchStash(cwd: string): Promise<BranchStash> {
  const ref = `refs/canopy/branch-switch/${Bun.randomUUIDv7()}`;
  const temporary = await mkdtemp(join(tmpdir(), "canopy-branch-stash-"));
  const env = { ...identity, GIT_LITERAL_PATHSPECS: "1", GIT_INDEX_FILE: join(temporary, "index") };

  const run = async (args: string[], text?: string) => {
    const result = await git(cwd, args, undefined, { env, ...(text !== undefined && { text }) });

    if (!result.ok) throw new GitError("STASH_FAILED", "Could not save local changes. The branch was not switched.");

    return result.stdout.trim();
  };

  try {
    const head = (await gitOk(cwd, ["rev-parse", "HEAD"], "STASH_FAILED")).trim();
    const tracked = await git(cwd, ["stash", "create", "Canopy branch switch"], undefined, { env: identity });

    if (!tracked.ok) throw new GitError("STASH_FAILED", "Could not save local changes. The branch was not switched.");
    const trackedCommit = tracked.stdout.trim();
    const indexTree = (await gitOk(cwd, ["write-tree"], "STASH_FAILED")).trim();

    const index = trackedCommit
      ? (await gitOk(cwd, ["rev-parse", `${trackedCommit}^2`], "STASH_FAILED")).trim()
      : await run(["commit-tree", indexTree, "-p", head], "Canopy saved index\n");

    const workingTree = (await gitOk(cwd, ["rev-parse", `${trackedCommit || head}^{tree}`], "STASH_FAILED")).trim();
    const files = await gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], "STASH_FAILED");
    const untracked = files.split("\0").filter(Boolean);
    const parents = ["-p", head, "-p", index];

    if (untracked.length) {
      await run(["read-tree", "--empty"]);
      await run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], files);
      const tree = await run(["write-tree"]);
      const commit = await run(["commit-tree", tree], "Canopy saved untracked files\n");
      parents.push("-p", commit);
    }

    const commit = await run(["commit-tree", workingTree, ...parents], "Canopy branch switch\n");
    await gitOk(cwd, ["update-ref", ref, commit, ""], "STASH_FAILED");

    return { ref, commit, untracked };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Recovery is allowed to outlive the command deadline; the private ref remains if any step fails. */
export async function restoreBranchStash(cwd: string, stash: BranchStash): Promise<string> {
  return recoverGit(async () => {
    let applied = false;

    try {
      applied = (await git(cwd, ["stash", "apply", "--index", stash.commit])).ok;
    } catch {
      // Keep the recovery ref even when git is unavailable or the restoration times out.
    }

    if (applied) {
      try {
        if ((await git(cwd, ["update-ref", "-d", stash.ref, stash.commit])).ok) return "";
      } catch {
        // Restored files are safe; leave the private recovery ref intact.
      }

      return `Local changes were restored. The saved stash remains at ${stash.ref}.`;
    }

    // A standard stash entry makes manual recovery convenient, without touching other saved stashes.
    try {
      await git(cwd, ["stash", "store", "-m", `Canopy recovery: ${stash.ref}`, stash.commit]);
    } catch {
      // The private ref already protects all saved objects, independently of the shared stash reflog.
    }

    return `Local changes could not be fully restored. Resolve conflicts before continuing. The saved stash is preserved at ${stash.ref}; recover it with git stash apply --index ${stash.ref}.`;
  });
}

export async function clearBranchStash(cwd: string, stash: BranchStash): Promise<void> {
  await gitOk(cwd, ["reset", "--hard", "HEAD"], "STASH_FAILED");

  for (let offset = 0; offset < stash.untracked.length; offset += 100)
    await gitOk(
      cwd,
      ["--literal-pathspecs", "clean", "-f", "--", ...stash.untracked.slice(offset, offset + 100)],
      "STASH_FAILED",
    );
}
