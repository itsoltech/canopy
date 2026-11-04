import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("squash/rebase cleanup over gateway-worker gRPC", () => {
  const dir = tempDir("canopy-worktree-merged-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir);
    await f.settings({ cleanupMerged: true });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("a multi-commit squash is merged even without the branch upstream; cleanup removes its checkout", async () => {
    const thread = await f.tree();
    commit(thread.cwd, "squash-one.txt", "one\n");
    commit(thread.cwd, "squash-two.txt", "two\n");
    git(f.repo, "merge", "--squash", thread.worktree!.branch);
    git(f.repo, "commit", "-qm", "squash");
    commit(f.repo, "later.txt", "unrelated base change\n");
    git(f.repo, "push", "-q", "origin", "main");
    const entry = await f.entry(thread.worktree!.id);
    expect(entry.status).toMatchObject({ merged: true, unpushed: false, unchanged: false });
    expect(entry.wouldRemove).toBe(true);
    const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id);
    expect(removed?.removed).toBe(true);
    expect(existsSync(thread.cwd)).toBe(false);
    expect(git(f.repo, "branch", "--list", thread.worktree!.branch)).not.toBe("");
  });

  test("rebased commits are patch-equivalent to the fetched base", async () => {
    const thread = await f.tree();
    const head = commit(thread.cwd, "rebased.txt", "rebased\n");
    commit(f.repo, "base-before-rebase.txt", "base\n");
    git(f.repo, "cherry-pick", head);
    expect(git(f.repo, "rev-parse", "HEAD")).not.toBe(head);
    git(f.repo, "push", "-q", "origin", "main");
    expect((await f.entry(thread.worktree!.id)).status).toMatchObject({ merged: true, unpushed: false });
  });

  test("a partially merged branch is kept and still requires confirmation", async () => {
    const thread = await f.tree();
    const first = commit(thread.cwd, "partial-one.txt", "one\n");
    commit(thread.cwd, "partial-two.txt", "two\n");
    git(f.repo, "cherry-pick", first);
    git(f.repo, "push", "-q", "origin", "main");
    const entry = await f.entry(thread.worktree!.id);
    expect(entry.status).toMatchObject({ merged: false, unpushed: true });
    expect(entry.wouldRemove).toBe(false);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id)?.removed).toBe(false);
    expect(existsSync(thread.cwd)).toBe(true);
  });
});
