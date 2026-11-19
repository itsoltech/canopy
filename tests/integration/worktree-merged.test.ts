import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { eventually } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("squash/rebase cleanup over gateway-worker gRPC", () => {
  const dir = tempDir("canopy-worktree-merged-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities: ["archived_branch_cleanup"] });
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
    await f.settings({ deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${thread.id}::uuid`);
    const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id);
    expect(removed).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(thread.cwd)).toBe(false);
    expect(git(f.repo, "branch", "--list", thread.worktree!.branch)).toBe("");
  });

  test("a removed checkout releases its branch after both archiving and a later merge", async () => {
    await f.settings({ deleteLocalBranch: true, cleanupMerged: false });
    const thread = await f.tree();
    const branch = thread.worktree!.branch;
    const head = commit(thread.cwd, "merged-later.txt");
    git(thread.cwd, "push", "-qu", "origin", branch);
    expect(await f.remove(thread.worktree!.id)).toMatchObject({ removed: true, branchDeleted: false });
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${thread.id}::uuid`);
    await f.cleanup(false);
    expect(git(f.repo, "rev-parse", branch)).toBe(head);
    git(f.repo, "merge", "--ff-only", branch);
    git(f.repo, "push", "-q", "origin", "main");
    await f.settings({ deleteLocalBranch: false });
    await f.cleanup(false);
    expect(git(f.repo, "rev-parse", branch)).toBe(head);
    const stacked = await f.tree(branch);
    await f.settings({ deleteLocalBranch: true });
    await f.cleanup(false);
    expect(git(f.repo, "rev-parse", branch)).toBe(head);
    await f.gw.api.setThreadArchived({ threadId: stacked.id, archived: true });
    await f.cleanup(true);
    expect(git(f.repo, "rev-parse", branch)).toBe(head);
    await f.cleanup(false);
    expect(git(f.repo, "branch", "--list", branch)).toBe("");
    await f.settings({ cleanupMerged: true });
    expect(git(f.origin, "rev-parse", `refs/heads/${branch}`)).toBe(head);
  });

  test("reconnect reconciles a lost branch cleanup without deleting after opt-out", async () => {
    await f.settings({ deleteLocalBranch: true });
    const thread = await f.tree();
    const id = thread.worktree!.id;
    const branch = thread.worktree!.branch;
    const head = git(thread.cwd, "rev-parse", "HEAD");
    expect(await f.remove(id)).toMatchObject({ removed: true, branchDeleted: false });
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${thread.id}::uuid`);

    const reservation = () =>
      f.sql(
        (sql) => sql<{ removal_token: string | null; candidate: boolean }>`
      SELECT removal_token, branch_cleanup_source IS NOT NULL AS candidate FROM worktrees WHERE id=${id}::uuid`,
      );

    const handle = f.host.handleCommand.bind(f.host);
    let attempt = "";
    let reconciled = "";
    f.host.handleCommand = async (command) => {
      if (command.kind.case === "cleanupRemovedBranch") {
        if (command.kind.value.target?.id === id && !attempt) {
          attempt = command.commandId;
          f.disconnect();

          return undefined;
        }

        if (command.kind.value.reconcileOnly) reconciled = command.commandId;
      }

      return handle(command);
    };

    try {
      await f.cleanup(false);
      expect(attempt).not.toBe("");
      expect(await reservation()).toEqual([{ removal_token: attempt, candidate: true }]);
      await f.settings({ deleteLocalBranch: false });
      await f.connect();
      const rows = await eventually(reservation, (rows) => rows[0]?.removal_token === null);
      expect(rows).toEqual([{ removal_token: null, candidate: true }]);
      expect(reconciled).toBe(attempt);
      expect(git(f.repo, "rev-parse", branch)).toBe(head);
    } finally {
      f.host.handleCommand = handle;
    }
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

  test("archival removes a pushed squash branch after upstream deletion and later edits obscure the merge", async () => {
    const thread = await f.tree();
    commit(thread.cwd, "squash-edited.txt", "first version\n");
    const head = commit(thread.cwd, "squash-edited.txt", "squashed version\n");
    git(thread.cwd, "push", "-qu", "origin", thread.worktree!.branch);
    git(f.repo, "merge", "--squash", thread.worktree!.branch);
    git(f.repo, "commit", "-qm", "squash edited lines");
    git(f.repo, "push", "-q", "origin", "main");
    git(f.repo, "push", "-q", "origin", "--delete", thread.worktree!.branch);
    commit(f.repo, "squash-edited.txt", "later base version\n");
    git(f.repo, "push", "-q", "origin", "main");
    const before = (await f.cleanup()).entries.find((e) => e.worktree?.id === thread.worktree!.id)!;
    expect(before.status).toMatchObject({ merged: false, unpushed: true, dirtyFiles: 0 });
    expect(before).toMatchObject({ wouldRemove: false, confirmationRequired: true });
    await f.settings({ cleanupSettled: true, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    await f.sql(
      (sql) => sql`UPDATE threads SET archived_at = now() - interval '24 hours' WHERE id = ${thread.id}::uuid`,
    );

    try {
      const preview = (await f.cleanup()).entries.find((e) => e.worktree?.id === thread.worktree!.id)!;
      expect(preview.status).toMatchObject({ merged: false, unpushed: true });
      expect(preview).toMatchObject({
        wouldRemove: true,
        confirmationRequired: true,
        detail: "All threads archived",
      });
      const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === thread.worktree!.id);
      expect(removed).toMatchObject({ removed: true, branchDeleted: false });
      expect(existsSync(thread.cwd)).toBe(false);
      expect(git(f.repo, "rev-parse", thread.worktree!.branch)).toBe(head);
      expect(git(f.repo, "show", `${thread.worktree!.branch}:squash-edited.txt`)).toBe("squashed version");
    } finally {
      await f.settings({ cleanupSettled: false, deleteLocalBranch: false });
    }
  });
});
