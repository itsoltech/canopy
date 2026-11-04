import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "./git.ts";

/** Never send a remote URL (which may contain credentials) to the gateway. */
export function githubRepository(remote: string): string {
  const match =
    /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    );

  return match?.[1] ?? "";
}

/** Ancestor, rebase/cherry-pick, or complete squash patch contained in the fetched base. */
export async function mergedInto(repo: string, ref: string, head: string): Promise<boolean> {
  if (!ref || ref.startsWith("-")) return false;
  const verified = await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);

  if (!verified.ok) return false;
  const base = verified.stdout.trim();

  if ((await git(repo, ["merge-base", "--is-ancestor", head, base])).ok) return true;
  const common = await git(repo, ["merge-base", head, base]);

  if (!common.ok) return false;
  const cherry = await git(repo, ["cherry", base, head]);
  const commits = cherry.stdout.trim().split("\n").filter(Boolean);
  const merges = await gitOk(repo, ["rev-list", "--merges", `${base}..${head}`], "GIT_FAILED");

  if (!merges.trim() && cherry.ok && commits.length > 0 && commits.every((line) => line.startsWith("- "))) return true;

  const patch = await gitOk(
    repo,
    ["diff", "--binary", "--no-ext-diff", common.stdout.trim(), head, "--"],
    "GIT_FAILED",
  );

  if (!patch.trim()) return false;
  // An isolated index checks the base tree without touching any checkout, files or user's index.
  const dir = mkdtempSync(join(tmpdir(), "canopy-merged-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };

  try {
    const index = await git(repo, ["read-tree", base], undefined, { env });

    return (
      index.ok &&
      (
        await git(repo, ["apply", "--cached", "--reverse", "--check", "--whitespace=nowarn", "-"], undefined, {
          env,
          text: patch,
        })
      ).ok
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
