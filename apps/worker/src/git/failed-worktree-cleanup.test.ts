import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { addWorktree, WORKTREE_CLEANUP_WARNING } from "./add-worktree.ts";
import { FailedWorktreeCleanup } from "./failed-worktree-cleanup.ts";
import { reserveCheckout } from "./worktree-rollback.ts";

const temp = tempDirs();

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: repo,
    },
  );

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function fixture() {
  const dir = realpathSync(temp("canopy-failed-worktree-cleanup-"));
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(data);
  git(dir, "init", "-qb", "main", repo);
  git(repo, "config", "core.autocrlf", "true");
  writeFileSync(join(repo, "tracked.txt"), "first\nsecond\n");
  writeFileSync(join(repo, "z.txt"), "last\n");
  git(repo, "add", "tracked.txt", "z.txt");
  git(repo, "commit", "-qm", "base");
  const tree = { path: join(dir, "checkout"), commit: git(repo, "rev-parse", "HEAD"), branch: "feature/partial" };

  return { dir, repo, data, tree, admin: join(repo, ".git", "worktrees", "checkout") };
}

async function incomplete({
  backlink = "missing",
  beforeReceipt,
}: {
  backlink?: "missing" | "present";
  beforeReceipt?: (stage: ReturnType<typeof fixture>) => void;
} = {}) {
  const f = fixture();
  const { repo, tree, data, admin } = f;
  const marker = `Canopy worktree creation ${crypto.randomUUID()}`;
  const reservation = await reserveCheckout(repo, tree.path);
  git(repo, "update-ref", "--create-reflog", "-m", marker, `refs/heads/${tree.branch}`, tree.commit, "");
  git(repo, "worktree", "add", "--no-checkout", "--lock", "--reason", marker, tree.path, tree.branch);

  if (backlink === "missing") unlinkSync(join(tree.path, ".git"));
  writeFileSync(join(admin, "index.lock"), "");
  writeFileSync(join(tree.path, "tracked.txt"), "first\r\nsecond\r\n");
  beforeReceipt?.(f);

  const cleanup = new FailedWorktreeCleanup(data);
  const record = () => cleanup.rememberStopped(tree, marker, reservation, BigInt(Date.now() + 1) * 1_000_000n);

  return { ...f, marker, cleanup, record };
}

test.each(["missing", "present"] as const)(
  "cleans a verified partial checkout with the Git backlink %s after restart",
  async (backlink) => {
    const f = await incomplete({ backlink });
    const ordinary = join(f.dir, "ordinary");
    git(f.repo, "worktree", "add", "--lock", "--reason", f.marker, "-b", "ordinary", ordinary);
    writeFileSync(join(ordinary, "untracked.txt"), "keep");
    f.record();

    const cleanup = new FailedWorktreeCleanup(f.data);
    expect(await cleanup.inspect(f.repo, ordinary)).toMatchObject({ token: "", reason: expect.any(String) });

    const { token, reason } = await cleanup.inspect(f.repo, f.tree.path);

    expect({ token, reason }).toEqual({ token: expect.stringMatching(/^[0-9a-f]{64}$/), reason: "" });
    await cleanup.remove(f.repo, f.tree.path, token, () => {});
    expect(existsSync(f.tree.path)).toBe(false);
    expect(existsSync(f.admin)).toBe(false);
    expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(f.tree.commit);
    expect(readFileSync(join(ordinary, "untracked.txt"), "utf8")).toBe("keep");
    expect(git(f.repo, "worktree", "list", "--porcelain")).toContain(`locked ${f.marker}`);
    expect((await cleanup.inspect(f.repo, f.tree.path)).token).toBe("");
    expect(
      [...readdirSync(f.dir), ...readdirSync(join(f.repo, ".git"))].some((name) => name.startsWith(".canopy-cleanup-")),
    ).toBe(false);
  },
  15_000,
);

test("a Git lock and the matching creation reflog do not authorize cleanup without a worker receipt", async () => {
  const f = await incomplete();

  expect(await f.cleanup.inspect(f.repo, f.tree.path)).toEqual({
    token: "",
    reason: "Canopy could not verify a stopped checkout for this worktree.",
  });
  await expect(f.cleanup.remove(f.repo, f.tree.path, "forged", () => {})).rejects.toThrow("could not verify");
  expect(readFileSync(join(f.tree.path, "tracked.txt"), "utf8")).toBe("first\r\nsecond\r\n");
  expect(existsSync(f.admin)).toBe(true);
});

test.each(["changed tracked bytes", "untracked data", "unknown Git state"] as const)(
  "refuses a recorded failure with %s",
  async (change) => {
    const f = await incomplete({
      beforeReceipt: (stage) => {
        if (change === "changed tracked bytes") writeFileSync(join(stage.tree.path, "tracked.txt"), "user edit");

        if (change === "untracked data") writeFileSync(join(stage.tree.path, "untracked"), "user data");

        if (change === "unknown Git state") writeFileSync(join(stage.admin, "MERGE_HEAD"), stage.tree.commit);
      },
    });

    f.record();

    expect(await f.cleanup.inspect(f.repo, f.tree.path)).toEqual({
      token: "",
      reason: expect.stringContaining(change === "unknown Git state" ? "Git metadata" : "worktree folder"),
    });
    expect(existsSync(f.tree.path)).toBe(true);
    expect(existsSync(f.admin)).toBe(true);
  },
);

test.each(["completed checkout", "populated index lock", "recreated checkout", "branch moved and restored"] as const)(
  "refuses to act on a reviewed worktree after %s",
  async (change) => {
    const f = await incomplete();
    f.record();
    const { token } = await f.cleanup.inspect(f.repo, f.tree.path);
    expect(token).not.toBe("");

    if (change === "completed checkout") {
      writeFileSync(join(f.tree.path, ".git"), `gitdir: ${f.admin}\n`);
      unlinkSync(join(f.admin, "index.lock"));
      git(f.tree.path, "reset", "--hard", f.tree.commit);
    }

    if (change === "populated index lock") writeFileSync(join(f.admin, "index.lock"), "Git data");

    if (change === "recreated checkout") {
      renameSync(f.tree.path, join(f.dir, "moved"));
      mkdirSync(f.tree.path);
      writeFileSync(join(f.tree.path, "tracked.txt"), "first\r\nsecond\r\n");
    }

    if (change === "branch moved and restored") {
      git(f.repo, "commit", "--allow-empty", "-qm", "new");
      git(f.repo, "update-ref", `refs/heads/${f.tree.branch}`, "HEAD");
      git(f.repo, "update-ref", "-m", f.marker, `refs/heads/${f.tree.branch}`, f.tree.commit);
    }

    await expect(f.cleanup.remove(f.repo, f.tree.path, token, () => {})).rejects.toMatchObject({
      code: "WORKTREE_CLEANUP_BLOCKED",
    });
    expect(readFileSync(join(f.tree.path, "tracked.txt"), "utf8")).toBe("first\r\nsecond\r\n");
    expect(existsSync(f.admin)).toBe(true);
    expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(f.tree.commit);
  },
);

test("revalidates both directories after the idle check and serializes conflicting cleanup requests", async () => {
  const f = await incomplete();
  f.record();
  const { token } = await f.cleanup.inspect(f.repo, f.tree.path);
  expect(token).not.toBe("");
  git(f.repo, "commit", "--allow-empty", "-qm", "new");

  const checked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();

  const first = f.cleanup
    .remove(f.repo, f.tree.path, token, async () => {
      checked.resolve();
      await resume.promise;
    })
    .catch((error: Error) => error);

  try {
    await Promise.race([
      checked.promise,
      first.then((result) => {
        throw new Error("Cleanup did not reach the idle check", { cause: result });
      }),
    ]);
    await expect(f.cleanup.remove(f.repo, f.tree.path, token, () => {})).rejects.toThrow("already in progress");

    const attemptedMove = Bun.spawnSync(
      ["git", "-c", "core.filesRefLockTimeout=0", "update-ref", `refs/heads/${f.tree.branch}`, "HEAD"],
      { cwd: f.repo },
    );

    expect(attemptedMove.stderr.toString()).toContain("cannot lock ref");
    writeFileSync(join(f.admin, "index.lock"), "index write started");
  } finally {
    resume.resolve();
    expect(await first).toMatchObject({ code: "WORKTREE_CLEANUP_BLOCKED" });
  }

  expect(readFileSync(join(f.tree.path, "tracked.txt"), "utf8")).toBe("first\r\nsecond\r\n");
  expect(readFileSync(join(f.admin, "index.lock"), "utf8")).toBe("index write started");
  expect(git(f.repo, "rev-parse", `refs/heads/${f.tree.branch}`)).toBe(f.tree.commit);
});

test.skipIf(process.platform === "win32")(
  "can clean a native timed-out checkout after a transient Git failure blocks automatic rollback",
  async () => {
    const f = fixture();
    git(f.repo, "config", "user.name", "T");
    git(f.repo, "config", "user.email", "t@x");
    writeFileSync(join(f.repo, ".gitattributes"), "z.txt filter=paused\n");
    git(f.repo, "add", ".gitattributes");
    git(f.repo, "commit", "-qm", "use filter");
    const tree = { ...f.tree, commit: git(f.repo, "rev-parse", "HEAD") };
    writeFileSync(join(f.dir, "pause"), "touch ../pause-ready\nsleep 15\ncat\n");
    git(f.repo, "config", "filter.paused.smudge", "sh ../pause");
    git(f.repo, "config", "filter.paused.required", "true");
    const cleanup = new FailedWorktreeCleanup(f.data);
    const config = join(f.repo, ".git", "config");
    const original = readFileSync(config);
    const attempt = addWorktree(f.repo, tree, 3500, cleanup).catch((error: Error) => error);

    try {
      const ready = join(f.dir, "pause-ready");
      const deadline = performance.now() + 3000;

      while (!existsSync(ready) && performance.now() < deadline) await Bun.sleep(15);
      expect(existsSync(ready)).toBe(true);
      expect(existsSync(join(tree.path, ".git"))).toBe(true);
      // The already-running checkout read the good config. Rollback starts a fresh Git process.
      writeFileSync(config, "[core]\nrepositoryformatversion = 999\n");
      expect(await attempt).toMatchObject({
        code: "GIT_TIMEOUT",
        cause: { treeTerminated: true },
        message: expect.stringContaining(WORKTREE_CLEANUP_WARNING),
      });
    } finally {
      await attempt;
      writeFileSync(config, original);
    }

    expect(existsSync(join(f.admin, "index"))).toBe(false);
    const { token, reason } = await cleanup.inspect(f.repo, tree.path);
    expect({ token, reason }).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      reason: "",
    });
    await cleanup.remove(f.repo, tree.path, token, () => {});
    expect(existsSync(tree.path)).toBe(false);
    expect(existsSync(f.admin)).toBe(false);
    expect(git(f.repo, "rev-parse", `refs/heads/${tree.branch}`)).toBe(tree.commit);
  },
  22_000,
);
