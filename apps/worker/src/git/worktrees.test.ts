/**
 * Folder names of new worktrees (docs/worktrees.md, "Położenie"): random, and never one that a file, a registered
 * worktree (even with its folder gone) or git's own worktree records already use. Real git, temporary repository.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { GitError } from "./git.ts";
import { freeFolder, randomFolder } from "./worktrees.ts";

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

describe("worktree folders", () => {
  const dir = tempDir("canopy-worktree-folders-");
  const repo = join(dir, "repo");
  const parent = join(dir, "root", "repo");
  mkdirSync(parent, { recursive: true });
  sh(dir, "init", "-q", "-b", "main", repo);
  sh(repo, "commit", "-q", "--allow-empty", "-m", "start");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("random names are short, lower case and unambiguous", () => {
    const names = new Set(Array.from({ length: 200 }, randomFolder));
    expect(names.size).toBe(200);

    for (const name of names) expect(name).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/);
  });

  test("a taken folder, a registered worktree with its folder gone and a git record name are skipped", async () => {
    writeFileSync(join(parent, "taken1"), "not a worktree");
    sh(repo, "worktree", "add", "-q", "-b", "gone", join(parent, "gone22"));
    rmSync(join(parent, "gone22"), { recursive: true });
    mkdirSync(join(repo, ".git", "worktrees", "admin3"), { recursive: true });
    const draws = ["taken1", "gone22", "admin3", "free44"];

    expect(await freeFolder(repo, parent, () => draws.shift()!)).toBe(join(parent, "free44"));
    expect(draws).toEqual([]);
  });

  test("when every draw is taken, creation stops with a clear error", async () => {
    const code = await freeFolder(repo, parent, () => "taken1").then(
      () => "",
      (error: Error) => (error instanceof GitError ? error.code : error.message),
    );

    expect(code).toBe("PATH_EXISTS");
  });
});
