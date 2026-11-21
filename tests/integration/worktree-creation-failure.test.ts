import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { addWorktree, WORKTREE_CLEANUP_WARNING } from "../../apps/worker/src/git/add-worktree.ts";
import { freshGit, prepareWorktreeGit } from "../../apps/worker/src/git/git.ts";
import {
  atPath,
  registeredWorktrees,
  reserveCheckout,
  rollbackWorktree,
} from "../../apps/worker/src/git/worktree-rollback.ts";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", "--", file);
  git(repo, "commit", "-qm", "change");

  return git(repo, "rev-parse", "HEAD");
}

const temp = tempDirs();

function fixture() {
  const dir = realpathSync(temp("canopy-worktree-creation-failure-"));
  const repo = join(dir, "repo");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@x");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  const base = commit(repo, "README.md", "hello");
  const tree = { path: join(dir, "checkout"), branch: "canopy/task", commit: base };
  const create = (timeoutMs?: number) => freshGit(() => addWorktree(repo, tree, timeoutMs));
  const branches = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const worktrees = () => git(repo, "worktree", "list", "--porcelain");

  return { dir, repo, hooks, tree, create, branches, worktrees, admin: join(repo, ".git", "worktrees", "checkout") };
}

function withIncompleteCheckout() {
  const f = fixture();
  writeFileSync(join(f.repo, ".gitattributes"), "z.txt filter=fixture\n");
  mkdirSync(join(f.repo, "a"));
  writeFileSync(join(f.repo, "a", "tracked.txt"), "first\nsecond\n");
  git(f.repo, "add", ".gitattributes", "a/tracked.txt");
  f.tree.commit = commit(f.repo, "z.txt", "last\n");
  git(f.repo, "config", "core.autocrlf", "true");

  // Git normally writes .git before opening index.lock. Model the reported missing backlink explicitly.
  writeFileSync(
    join(f.dir, "smudge"),
    [
      "set -eu",
      "admin=../repo/.git/worktrees/checkout",
      "test -f a/tracked.txt",
      'test -f "$admin/index.lock"',
      'test ! -s "$admin/index.lock"',
      'test ! -e "$admin/index"',
      "rm .git",
      "touch ../incomplete",
      // Keep the MSYS shell alive as the sleeper's parent so taskkill can traverse the native process tree.
      "sleep 15",
      "cat",
      "",
    ].join("\n"),
  );

  return f;
}

test("a checkout admitted before preparation expires can still finish and unlock the worktree", async () => {
  const f = fixture();
  git(f.repo, "config", "core.hooksPath", f.hooks);
  writeFileSync(join(f.hooks, "post-checkout"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const startBy = Date.now() + 4000;

  await prepareWorktreeGit(BigInt(startBy), () => f.create());

  expect(Date.now()).toBeGreaterThan(startBy);
  expect(git(f.tree.path, "symbolic-ref", "--short", "HEAD")).toBe(f.tree.branch);
  expect(readFileSync(join(f.tree.path, "README.md"), "utf8")).toBe("hello");
  expect(f.worktrees()).not.toContain("locked Canopy worktree creation");
}, 18_000);

test("an expired preparation leaves the checkout and branch untouched", () => {
  const f = fixture();

  expect(() => prepareWorktreeGit(BigInt(Date.now() - 1000), () => f.create())).toThrow("could not prepare");
  expect(existsSync(f.tree.path)).toBe(false);
  expect(f.branches()).toBe("refs/heads/main");
});

test.skipIf(process.platform === "win32")(
  "a killed checkout process rolls back without an index or .git",
  async () => {
    const f = withIncompleteCheckout();
    git(f.repo, "config", "filter.fixture.smudge", "sh ../smudge");
    git(f.repo, "config", "filter.fixture.required", "true");

    const startBy = BigInt(Date.now() + 2500);

    const result = prepareWorktreeGit(startBy, () => f.create(3500)).then(
      () => undefined,
      (error: Error) => error,
    );

    try {
      const incomplete = join(f.dir, "incomplete");
      const limit = performance.now() + 3000;

      while (!existsSync(incomplete) && performance.now() < limit) await Bun.sleep(15);
      expect(existsSync(incomplete)).toBe(true);
      expect(existsSync(join(f.tree.path, ".git"))).toBe(false);
      expect(lstatSync(join(f.admin, "index.lock")).size).toBe(0);
      expect(existsSync(join(f.admin, "index"))).toBe(false);
      expect(f.worktrees()).toContain("locked Canopy worktree creation ");
    } finally {
      expect(await result).toMatchObject({
        code: "GIT_TIMEOUT",
        cause: { treeTerminated: true, timing: { limitMs: 3500 } },
        message: expect.stringMatching(
          /^Git timed out after \d+(?:\.\d{1,3})? s while creating the worktree\. The limit was 3\.5 s\.$/,
        ),
      });
    }

    expect(existsSync(f.tree.path)).toBe(false);
    expect(existsSync(f.admin)).toBe(false);
    expect(f.branches()).toBe("refs/heads/main");
  },
  22_000,
);

async function stageInterruptedCheckout(f: ReturnType<typeof fixture>) {
  const marker = `Canopy worktree creation ${crypto.randomUUID()}`;
  const reservation = await reserveCheckout(f.repo, f.tree.path);
  git(f.repo, "update-ref", "--create-reflog", "-m", marker, `refs/heads/${f.tree.branch}`, f.tree.commit, "");
  git(f.repo, "worktree", "add", "--no-checkout", "--lock", "--reason", marker, f.tree.path, f.tree.branch);
  // Native Git provides the linked worktree metadata. Model the files left once checkout has stopped.
  mkdirSync(join(f.tree.path, "a"));
  writeFileSync(join(f.tree.path, "a", "tracked.txt"), "first\r\nsecond\r\n");
  unlinkSync(join(f.tree.path, ".git"));
  writeFileSync(join(f.admin, "index.lock"), "");
  expect(existsSync(join(f.admin, "index"))).toBe(false);
  const registered = await registeredWorktrees(f.repo);
  expect(registered).toContainEqual(
    expect.arrayContaining([`HEAD ${f.tree.commit}`, `branch refs/heads/${f.tree.branch}`, `locked ${marker}`]),
  );
  const listedPath = registered.find((entry) => entry.includes(`locked ${marker}`))?.[0];

  expect({ matches: atPath(registered, f.tree.path).length, requested: f.tree.path, listedPath }).toEqual({
    matches: 1,
    requested: f.tree.path,
    listedPath,
  });

  return () => rollbackWorktree(f.repo, f.tree, marker, reservation, true);
}

test("rollback removes the incomplete checkout, its registration and branch while retaining other worktrees", async () => {
  const f = withIncompleteCheckout();
  const other = join(f.dir, "other");
  const stale = join(f.dir, "stale");
  git(f.repo, "worktree", "add", "--lock", "--reason", "keep this lock", "-b", "other", other);
  git(f.repo, "worktree", "add", "-b", "stale", stale);
  rmSync(stale, { recursive: true });
  writeFileSync(join(other, "keep.txt"), "user data");
  const before = f.worktrees();
  const branches = f.branches();
  const rollback = await stageInterruptedCheckout(f);

  expect(await rollback()).toBe("removed");
  expect(existsSync(f.tree.path)).toBe(false);
  expect(existsSync(f.admin)).toBe(false);
  expect(f.worktrees()).toBe(before);
  expect(f.branches()).toBe(branches);
  expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("user data");
  await f.create();
  expect(git(f.tree.path, "symbolic-ref", "--short", "HEAD")).toBe(f.tree.branch);
}, 15_000);

test.each(["edited tracked file", "untracked file", "directory link"] as const)(
  "rollback preserves an incomplete checkout with %s",
  async (change) => {
    const f = withIncompleteCheckout();
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside");
    const backup = join(f.tree.path, change === "edited tracked file" ? "a/tracked.txt" : "local");
    const rollback = await stageInterruptedCheckout(f);

    if (change === "directory link") symlinkSync(outside, backup, process.platform === "win32" ? "junction" : "dir");
    else writeFileSync(backup, "user data");

    expect(await rollback()).toBe("checkout changed");
    expect(existsSync(f.admin)).toBe(true);
    expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(f.tree.commit);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");

    if (change === "directory link") expect(lstatSync(backup).isSymbolicLink()).toBe(true);
    else expect(readFileSync(backup, "utf8")).toBe("user data");
  },
  15_000,
);

test("rollback preserves an incomplete checkout whose index lock contains data", async () => {
  const f = withIncompleteCheckout();
  const rollback = await stageInterruptedCheckout(f);
  const lock = join(f.admin, "index.lock");
  writeFileSync(lock, "index data");

  expect(await rollback()).toBe("index changed");
  expect(existsSync(f.tree.path)).toBe(true);
  expect(readFileSync(lock, "utf8")).toBe("index data");
  expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(f.tree.commit);
}, 15_000);

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

    const result = f.create(1500).catch((error: Error) => error);

    try {
      const deadline = performance.now() + 1400;

      while (!existsSync(started) && performance.now() < deadline) await Bun.sleep(15);
      expect(existsSync(started)).toBe(true);
      // Delay the timeout callback while Git is in the filter. A configured limit is not a measurement.
      Bun.sleepSync(1700);
    } finally {
      const error = await result;
      expect(error).toMatchObject({ code: "GIT_TIMEOUT", cause: { timing: { limitMs: 1500 } } });

      const match =
        error instanceof Error &&
        /^Git timed out after (\d+(?:\.\d{1,3})?) s while creating the worktree\. The limit was 1\.5 s\.$/.exec(
          error.message,
        );

      expect(Number(match && match[1])).toBeGreaterThanOrEqual(1.65);
    }

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
