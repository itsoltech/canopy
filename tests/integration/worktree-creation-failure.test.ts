import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { addWorktree, WORKTREE_CLEANUP_WARNING } from "../../apps/worker/src/git/add-worktree.ts";
import { freshGit } from "../../apps/worker/src/git/git.ts";
import { commit, git } from "./support/worktrees.ts";

function fixture() {
  const dir = tempDir("canopy-worktree-creation-failure-");
  const repo = join(dir, "repo");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  git(dir, "init", "-q", "-b", "main", repo);
  const base = commit(repo, "README.md", "hello");
  const tree = { path: join(dir, "checkout"), branch: "canopy/task", commit: base };
  const create = (timeoutMs?: number) => freshGit(() => addWorktree(repo, tree, timeoutMs));
  const branches = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const worktrees = () => git(repo, "worktree", "list", "--porcelain");

  return { dir, repo, hooks, tree, create, branches, worktrees };
}

test.skipIf(process.platform === "win32")(
  "a timeout during a checkout filter rolls back an initializing worktree",
  async () => {
    const f = fixture();
    const filter = join(f.dir, "smudge");
    const started = join(f.dir, "smudge-started");
    writeFileSync(join(f.repo, ".gitattributes"), "README.md filter=fixture\n");
    git(f.repo, "add", ".gitattributes");
    f.tree.commit = commit(f.repo, "README.md", "filtered");
    writeFileSync(filter, `#!/bin/sh\ntouch "${started}"\nsleep 30\n`);
    git(f.repo, "config", "filter.fixture.smudge", `sh "${filter}"`);
    git(f.repo, "config", "filter.fixture.required", "true");

    await expect(f.create(1500)).rejects.toMatchObject({
      code: "GIT_TIMEOUT",
      message: "Git exceeded its time limit.",
    });
    expect(existsSync(started)).toBe(true);
    expect(existsSync(f.tree.path)).toBe(false);
    expect(f.branches()).toBe("refs/heads/main");
    expect(f.worktrees()).not.toContain(f.tree.path);
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "noisy and failing hooks are distinct and a retry reuses the same branch",
  async () => {
    const f = fixture();
    const other = join(f.dir, "existing");
    git(f.repo, "worktree", "add", "--lock", "--reason", "existing", "-b", "canopy/task-2", other);
    writeFileSync(join(other, "keep.txt"), "existing worktree");
    const before = f.worktrees();
    const hook = join(f.hooks, "post-checkout");
    git(f.repo, "config", "core.hooksPath", f.hooks);

    writeFileSync(hook, "#!/bin/sh\nhead -c 9437184 /dev/zero >&2\n", { mode: 0o755 });
    await expect(f.create()).rejects.toMatchObject({
      code: "GIT_OUTPUT_LIMIT",
      message: "Git produced too much output.",
    });
    expect(existsSync(f.tree.path)).toBe(false);
    expect(f.branches()).toBe("refs/heads/canopy/task-2\nrefs/heads/main");

    writeFileSync(hook, "#!/bin/sh\necho '/private/worker/repo' >&2\nexit 1\n");
    await expect(f.create()).rejects.toMatchObject({
      code: "WORKTREE_CHECKOUT_FAILED",
      message: "Git could not check out the worktree. Check the Git settings and filters.",
    });
    expect(existsSync(f.tree.path)).toBe(false);
    expect(f.worktrees()).toBe(before);
    expect(f.branches()).toBe("refs/heads/canopy/task-2\nrefs/heads/main");
    expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("existing worktree");

    git(f.repo, "config", "--unset", "core.hooksPath");
    await f.create();
    expect(git(f.tree.path, "symbolic-ref", "--short", "HEAD")).toBe(f.tree.branch);
    expect(readFileSync(join(f.tree.path, "README.md"), "utf8")).toBe("hello");
    expect(f.worktrees()).not.toContain("locked Canopy worktree creation");
  },
);

test.skipIf(process.platform === "win32")(
  "rollback preserves a branch that advances while checkout is running",
  async () => {
    const f = fixture();
    const newer = commit(f.repo, "README.md", "newer");
    git(f.repo, "config", "core.hooksPath", f.hooks);
    writeFileSync(join(f.hooks, "post-checkout"), `#!/bin/sh\ngit update-ref HEAD ${newer}\nexit 1\n`, { mode: 0o755 });

    await expect(f.create()).rejects.toMatchObject({
      code: "WORKTREE_CHECKOUT_FAILED",
      message: expect.stringContaining(WORKTREE_CLEANUP_WARNING),
    });
    expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(newer);
    expect(existsSync(f.tree.path)).toBe(true);
    expect(f.worktrees()).toContain(f.tree.path);
  },
);

test("a pre-existing branch at the same commit is not owned by the failed attempt", async () => {
  const f = fixture();
  git(f.repo, "branch", f.tree.branch);
  const before = f.branches();

  await expect(f.create()).rejects.toMatchObject({ code: "WORKTREE_FAILED" });
  expect(f.branches()).toBe(before);
  expect(existsSync(f.tree.path)).toBe(false);
});
