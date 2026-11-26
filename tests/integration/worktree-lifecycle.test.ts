import { WorktreeCleanupSchedule } from "../../apps/gateway/src/worktrees/cleanup-schedule.ts";
import { setModules } from "./support/module-settings.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { CommandSchema, ItemStatus, Provider, ui } from "@canopy/contracts";
import { Journal } from "@canopy/worker/journal";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { eventually, failure } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("worktree lifecycle over gRPC", () => {
  const dir = tempDir("canopy-worktree-lifecycle-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.settings({
      cleanupDeletedThreads: false,
      cleanupMerged: false,
      cleanupInactiveDays: 0,
      cleanupSettled: false,
      cleanupUnchanged: false,
      keepLocalChanges: true,
      deleteLocalBranch: false,
    });
  });

  test("scheduled cleanup skips ineligible worktrees before scanning while manual preview reports their Git status", async () => {
    const thread = await f.tree();
    const id = thread.worktree!.id;
    const head = git(thread.cwd, "rev-parse", "HEAD");
    const handle = f.host.handleCommand.bind(f.host);
    let scanned = false;
    f.host.handleCommand = (command) => {
      if (command.kind.case === "scanWorktrees" && command.kind.value.targets.some((target) => target.id === id))
        scanned = true;

      return handle(command);
    };

    const expectSkipped = async (detail: string) => {
      scanned = false;
      await f.gw.core.worktreeCleanup.tick(f.workerId);
      expect(scanned).toBe(false);
      const preview = (await f.cleanup()).entries.find((entry) => entry.worktree?.id === id);
      expect(preview).toMatchObject({ detail, wouldRemove: false, status: { headCommit: head, unchanged: true } });
      expect(scanned).toBe(true);
    };

    try {
      await f.settings({ cleanupSettled: true, cleanupDeletedThreads: true, cleanupInactiveDays: 7 });
      await expectSkipped("No cleanup policy matches");
      await f.settings({ cleanupUnchanged: true });
      await f.sql(
        (sql) => sql`INSERT INTO interaction_requests (id, thread_id, kind, request, routed_to)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${thread.id}::uuid, 'permission', '{}'::jsonb, 'human')`,
      );
      await expectSkipped("A thread is still using this worktree");
      await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });
      await expectSkipped("Kept: archived less than 24 hours ago");

      await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${thread.id}::uuid`);
      await f.gw.core.worktreeCleanup.tick(f.workerId);
      expect(existsSync(thread.cwd)).toBe(false);
    } finally {
      f.host.handleCommand = handle;
    }
  });

  test.each(["archived", "merged", "unchanged", "inactive"])(
    "archive grace blocks %s cleanup until the 24-hour boundary",
    async (rule) => {
      const t = await f.tree();
      await f.settings({
        cleanupSettled: rule === "archived",
        cleanupMerged: rule === "merged",
        cleanupUnchanged: rule === "unchanged",
        cleanupInactiveDays: rule === "inactive" ? 7 : 0,
      });

      if (rule === "archived") {
        commit(t.cwd, "recoverable.txt");
        writeFileSync(join(t.cwd, "local.txt"), "preserve during the archive delay");
      }

      if (rule === "inactive") {
        const old = new Date(Date.now() - 10 * 86_400_000);
        await f.sql((sql) => sql`UPDATE threads SET created_at=${old} WHERE id=${t.id}::uuid`);
        await f.sql((sql) => sql`UPDATE worktrees SET last_used_at=${old} WHERE id=${t.worktree!.id}::uuid`);

        for (const path of [
          t.cwd,
          git(t.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index"),
          git(t.cwd, "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"),
        ])
          utimesSync(path, old, old);
      }

      if (rule !== "archived") expect((await f.entry(t.worktree!.id)).wouldRemove).toBe(true);
      await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
      expect(await f.entry(t.worktree!.id)).toMatchObject({
        wouldRemove: false,
        detail: "Kept: archived less than 24 hours ago",
      });

      for (const dryRun of [true, false]) {
        const result = await f.gw.api.cleanupWorktrees({ projectId: f.project.id, workerId: f.workerId, dryRun });
        expect(result.entries.find((e) => e.worktree?.id === t.worktree!.id)).toMatchObject({
          wouldRemove: false,
          removed: false,
          detail: "Kept: archived less than 24 hours ago",
        });
        expect(existsSync(t.cwd)).toBe(true);
      }

      if (rule === "archived") {
        await f.gw.core.worktreeCleanup.tick(f.workerId);
        expect(existsSync(join(t.cwd, "local.txt"))).toBe(true);
        expect((await f.entry(t.worktree!.id)).removed).toBe(false);
      }

      await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '23 hours' WHERE id=${t.id}::uuid`);
      expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)).toMatchObject({
        wouldRemove: false,
        detail: "Kept: archived less than 24 hours ago",
      });
      await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '24 hours' WHERE id=${t.id}::uuid`);
      expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(true);
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
      expect(existsSync(t.cwd)).toBe(false);
    },
  );

  test("the latest nondeleted sharing archive controls grace and rearchival restarts it", async () => {
    const t = await f.tree();

    const shared = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: f.workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: t.worktree!.id,
      })
    ).thread!;

    await f.settled(shared);
    rmSync(join(t.cwd, "worker-started.txt"));
    await f.settings({ cleanupSettled: true, cleanupMerged: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    expect(await f.entry(t.worktree!.id)).toMatchObject({
      wouldRemove: false,
      detail: "Kept: archived less than 24 hours ago",
    });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    expect(await f.entry(t.worktree!.id)).toMatchObject({
      wouldRemove: true,
      detail: "Branch merged into the default or base branch",
    });
    await f.gw.api.setThreadArchived({ threadId: shared.id, archived: true });
    expect(await f.entry(t.worktree!.id)).toMatchObject({
      wouldRemove: false,
      detail: "Kept: archived less than 24 hours ago",
    });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${shared.id}::uuid`);
    expect((await f.entry(t.worktree!.id)).wouldRemove).toBe(true);
    await f.gw.api.setThreadArchived({ threadId: shared.id, archived: false });
    expect(await f.entry(t.worktree!.id)).toMatchObject({
      wouldRemove: true,
      detail: "Branch merged into the default or base branch",
    });
    await f.gw.api.setThreadArchived({ threadId: shared.id, archived: true });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)).toMatchObject({
      removed: false,
      detail: "Kept: archived less than 24 hours ago",
    });
    expect(existsSync(t.cwd)).toBe(true);
    await f.gw.api.deleteThread({ threadId: shared.id });
    expect(await f.entry(t.worktree!.id)).toMatchObject({ wouldRemove: true, detail: "All threads archived" });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
  });

  test("manual removal bypasses archive grace and still requires confirmation for local work", async () => {
    const t = await f.tree();
    const head = commit(t.cwd, "manual-recovery.txt");
    writeFileSync(join(t.cwd, "local.txt"), "discard only after confirmation");
    await f.settings({ cleanupSettled: true, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    expect(await f.entry(t.worktree!.id)).toMatchObject({
      confirmationRequired: true,
      wouldRemove: false,
      detail: "Kept: archived less than 24 hours ago",
    });
    expect(await failure(f.remove(t.worktree!.id))).toContain("explicit confirmation");
    expect(existsSync(t.cwd)).toBe(true);
    expect(await f.remove(t.worktree!.id, true)).toMatchObject({ removed: true, branchDeleted: false });
    expect(existsSync(t.cwd)).toBe(false);
    expect(git(f.repo, "rev-parse", t.worktree!.branch)).toBe(head);
  });

  test("unchanged policy: preview is read-only; execute removes and audits once, preserves history", async () => {
    const t = await f.tree();
    await f.settings({ cleanupUnchanged: true });
    const before = await f.entry(t.worktree!.id);
    expect(before.status).toMatchObject({ dirtyFiles: 0, unpushed: false, unchanged: true });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(true);
    expect(existsSync(t.cwd)).toBe(true);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toContain(t.worktree!.branch);
    expect((await f.gw.api.getThread({ threadId: t.id })).thread?.worktree?.removedAt).toBeDefined();
    expect(await f.entry(t.worktree!.id)).toMatchObject({ removed: true });
    expect(await failure(f.remove(t.worktree!.id))).toContain("removed");
    await f.cleanup(false);

    const audits = await f.sql(
      (sql) => sql`SELECT id FROM audit_log WHERE action = 'worktree.removed' AND target_id = ${t.worktree!.id}::uuid`,
    );

    expect(audits).toHaveLength(1);
    expect(
      await failure(f.gw.api.sendMessage({ threadId: t.id, text: "Do more", clientRequestId: Bun.randomUUIDv7() })),
    ).toContain("worktree removed");
    expect(await failure(f.gw.api.setGoal({ threadId: t.id, action: "set", objective: "Do more" }))).toContain(
      "worktree removed",
    );
  });

  test("deleted-thread policy waits until every sharing thread is deleted", async () => {
    const t = await f.tree();

    const shared = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: f.workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: t.worktree!.id,
      })
    ).thread!;

    await f.settled(shared);
    rmSync(join(t.cwd, "worker-started.txt"));
    const head = commit(t.cwd, "deleted-local.txt");
    writeFileSync(join(t.cwd, "untracked.txt"), "discard only after every thread is deleted");
    await f.settings({ cleanupDeletedThreads: true, deleteLocalBranch: true });
    await f.gw.api.deleteThread({ threadId: t.id });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    await f.gw.api.deleteThread({ threadId: shared.id });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)).toMatchObject({
      confirmationRequired: true,
      wouldRemove: true,
      detail: "All threads deleted",
    });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)).toMatchObject({
      removed: true,
      branchDeleted: false,
    });
    expect(git(f.repo, "rev-parse", t.worktree!.branch)).toBe(head);
  });

  test("merged policy fetches and verifies ancestry but keeps the branch of an open thread", async () => {
    const t = await f.tree();
    commit(t.cwd, "merged.txt");
    git(t.cwd, "push", "-qu", "origin", t.worktree!.branch);
    await f.settings({ cleanupMerged: true, deleteLocalBranch: true });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    git(f.repo, "merge", "-q", "--no-ff", "-m", "merge", t.worktree!.branch);
    git(f.repo, "push", "-q", "origin", "main");
    const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id);
    expect(removed).toMatchObject({ removed: true, branchDeleted: false });
    expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toContain(t.worktree!.branch);
  });

  test("cleanup keeps a merged archived branch on a worker without archived branch cleanup", async () => {
    const t = await f.tree();
    await f.settings({ cleanupSettled: true, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    const handle = f.host.handleCommand.bind(f.host);
    let checked = false;
    f.host.handleCommand = async (command) => {
      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === t.worktree!.id) {
        expect(command.kind.value).toMatchObject({
          deleteBranch: false,
          deleteArchivedBranch: false,
          trackBranchForCleanup: false,
        });
        checked = true;
      }

      return handle(command);
    };

    try {
      const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id);
      expect(removed).toMatchObject({ removed: true, branchDeleted: false });
      expect(checked).toBe(true);
      expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toContain(t.worktree!.branch);
    } finally {
      f.host.handleCommand = handle;
    }
  });

  test("inactive policy considers thread activity and local activity, then removes old trees", async () => {
    const t = await f.tree();
    await f.settings({ cleanupInactiveDays: 7 });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await f.sql((sql) => sql`UPDATE threads SET created_at = ${old} WHERE id = ${t.id}::uuid`);
    await f.sql((sql) => sql`UPDATE worktrees SET last_used_at = ${old} WHERE id = ${t.worktree!.id}::uuid`);

    for (const path of [
      t.cwd,
      git(t.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index"),
      git(t.cwd, "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"),
    ])
      utimesSync(path, old, old);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
  });

  test("settled policy requires archival after a completed turn", async () => {
    const t = await f.tree();
    await f.sql(
      (sql) => sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input,
      first_seq, last_seq, completed_at) VALUES
      (${Bun.randomUUIDv7()}::uuid, ${t.id}::uuid, 1, 'completed', 'user', ${f.gw.userId}::uuid, '{}', 1, 1, now())`,
    );
    await f.settings({ cleanupSettled: true });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
  });

  test("inactive cleanup preserves a worktree when an older turn completed recently", async () => {
    const t = await f.tree();
    const old = new Date(Date.now() - 20 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    await f.settings({ cleanupInactiveDays: 7 });
    await f.sql((sql) => sql`UPDATE threads SET created_at=${old} WHERE id=${t.id}::uuid`);
    await f.sql((sql) => sql`UPDATE worktrees SET last_used_at=${old} WHERE id=${t.worktree!.id}::uuid`);
    await f.sql(
      (sql) => sql`INSERT INTO turns(id,thread_id,ordinal,trigger,author_user_id,input,status,first_seq,last_seq,
      queued_at,started_at,completed_at) VALUES
      (${crypto.randomUUID()}::uuid,${t.id}::uuid,1,'user',${f.gw.userId}::uuid,'{}','completed',1,1,${old},NULL,${recent}),
      (${crypto.randomUUID()}::uuid,${t.id}::uuid,2,'user',${f.gw.userId}::uuid,'{}','completed',2,2,${old},NULL,NULL)`,
    );

    const inventory = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.worktreeInventory(f.gw.userId, "", "", t.worktree!.id)),
    );

    expect(new Date(inventory[0]!.last_activity_at).getTime()).toBe(recent.getTime());
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
  });

  test("dirty files require explicit confirmation even with keep-local-changes off; branch survives", async () => {
    const t = await f.tree();
    writeFileSync(join(t.cwd, "local.txt"), "do not lose");
    await f.settings({ cleanupMerged: true, keepLocalChanges: false, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    const preview = (await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
    expect(preview).toMatchObject({ confirmationRequired: true, wouldRemove: false });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
    expect(await failure(f.remove(t.worktree!.id))).toContain("explicit confirmation");
    expect(existsSync(join(t.cwd, "local.txt"))).toBe(true);
    expect((await f.remove(t.worktree!.id, true)).removed).toBe(true);
    expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toContain(t.worktree!.branch);
  });

  test("unpushed commits are protected and recoverable from the branch after confirmed removal", async () => {
    const t = await f.tree();
    const head = commit(t.cwd, "unpushed.txt");
    await f.settings({ cleanupMerged: true, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    expect((await f.entry(t.worktree!.id)).status?.unpushed).toBe(true);
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    expect(await failure(f.remove(t.worktree!.id))).toContain("explicit confirmation");
    expect((await f.remove(t.worktree!.id, true)).branchDeleted).toBe(false);
    expect(git(f.repo, "rev-parse", t.worktree!.branch)).toBe(head);
  });

  test("offline cleanup is deferred, manual actions refused, reconnect retries on the owning worker", async () => {
    const t = await f.tree();
    await f.settings({ cleanupUnchanged: true });
    f.disconnect();
    await eventually(
      () => f.gw.api.getOverview({}),
      (o) => !o.workers.find((w) => w.id === f.workerId)?.online,
    );
    expect((await f.entry(t.worktree!.id)).detail).toContain("offline");
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
    expect(await failure(f.remove(t.worktree!.id))).toContain("offline");
    expect(existsSync(t.cwd)).toBe(true);
    await setModules(f.gw, "bots");
    await f.connect();
    await f.gw.core.worktreeCleanup.tick(f.workerId);
    expect(existsSync(t.cwd)).toBe(true);
    await setModules(f.gw, "threads", "bots");
    await f.gw.core.worktreeCleanup.tick(f.workerId);
    await eventually(
      () => f.gw.api.listWorktrees({}),
      (r) => !r.entries.some((e) => e.worktree?.id === t.worktree!.id),
    );
    expect(existsSync(t.cwd)).toBe(false);
  });

  test("another owner's records cannot be listed, removed, or revealed", async () => {
    const userId = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("foreign@x", "Foreign")));

    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.insertWorktree({
          id: Bun.randomUUIDv7(),
          owner_user_id: userId,
          project_id: f.project.id,
          workspace_id: f.workspace.id,
          worker_id: f.workerId,
          path: join(f.dir, "foreign"),
          repo_root: f.repo,
          branch: "foreign",
          base_ref: "main",
          base_commit: "",
        }),
      ),
    );

    expect((await f.gw.api.listWorktrees({})).entries.some((e) => e.worktree?.id === foreign.id)).toBe(false);
    expect(await failure(f.gw.api.listWorktrees({ worktreeId: foreign.id }))).toContain("worktree not found");
    expect(await failure(f.gw.api.removeWorktree({ worktreeId: foreign.id }))).toContain("worktree not found");
    expect(await failure(f.gw.api.revealWorktree({ worktreeId: foreign.id }))).toContain("worktree not found");
  });

  test("cleanup fields inherit across every scope and reject invalid inactivity", async () => {
    await f.settings({ cleanupMerged: true, cleanupInactiveDays: 14 }, "", "");
    await f.settings({ cleanupInactiveDays: 30 }, "", f.workerId);
    await f.settings({ cleanupInactiveDays: 7 }, f.project.id, "");
    const exact = await f.settings({ cleanupInactiveDays: undefined, cleanupMerged: undefined });
    expect(exact.effective).toMatchObject({ cleanupMerged: true, cleanupInactiveDays: 7 });
    expect(exact.inheritedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "cleanupInactiveDays", projectId: f.project.id, workerId: "" }),
      ]),
    );
    expect(await failure(f.settings({ cleanupInactiveDays: 4000 }))).toContain("between 0 and 3650");
    await f.settings({ cleanupMerged: undefined, cleanupInactiveDays: undefined }, "", "");
    await f.settings({ cleanupInactiveDays: undefined }, "", f.workerId);
    await f.settings({ cleanupInactiveDays: undefined }, f.project.id, "");
  });

  test("gateway blocks removal while turns or interactions are pending, then cleans up after archival", async () => {
    const t = await f.tree();
    writeFileSync(join(t.cwd, "local.txt"), "discard only while idle");
    await f.settings({ cleanupSettled: true });
    await f.sql(
      (sql) => sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${t.id}::uuid, 1, 'queued', 'user', ${f.gw.userId}::uuid, '{}'::jsonb)`,
    );
    expect((await f.entry(t.worktree!.id)).busy).toBe(true);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
    expect(await failure(f.remove(t.worktree!.id, true))).toContain("still using");
    await f.sql((sql) => sql`UPDATE turns SET status = 'completed', last_seq = 1 WHERE thread_id = ${t.id}::uuid`);
    await f.sql(
      (sql) => sql`INSERT INTO interaction_requests (id, thread_id, kind, request, routed_to)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${t.id}::uuid, 'permission', '{}'::jsonb, 'human')`,
    );
    expect((await f.entry(t.worktree!.id)).busy).toBe(true);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
    expect(await failure(f.remove(t.worktree!.id, true))).toContain("still using");
    await f.sql(
      (sql) =>
        sql`UPDATE interaction_requests SET status = 'expired', answered_at = now() WHERE thread_id = ${t.id}::uuid`,
    );
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    await f.sql((sql) => sql`UPDATE threads SET archived_at=now()-interval '25 hours' WHERE id=${t.id}::uuid`);
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
  });

  test("worker rechecks dirty files, unpushed commits, HEAD and active background work", async () => {
    const t = await f.tree();
    const status = (await f.entry(t.worktree!.id)).status!;

    const request = {
      target: {
        id: t.worktree!.id,
        path: t.cwd,
        repoRoot: f.repo,
        branch: t.worktree!.branch,
        baseRef: "main",
        baseCommit: status.headCommit,
      },
      expectedHeadCommit: status.headCommit,
    };

    writeFileSync(join(t.cwd, "race.txt"), "written after preview");

    const run = (extra = {}) =>
      f.command({ commandId: Bun.randomUUIDv7(), kind: { case: "removeWorktree", value: { ...request, ...extra } } });

    expect(await run()).toMatchObject({ ok: false, errorCode: "CONFIRMATION_REQUIRED" });
    const next = commit(t.cwd, "race.txt", "new commit");
    expect(await run({ confirmLocalChanges: true })).toMatchObject({ ok: false, errorCode: "WORKTREE_CHANGED" });
    expect(await run({ expectedHeadCommit: next })).toMatchObject({ ok: false, errorCode: "CONFIRMATION_REQUIRED" });
    await f.runtime.runPromise(
      Journal.use((j) =>
        j.append(t.id, {
          body: {
            case: "itemStarted",
            value: {
              item: {
                itemId: "bg:cleanup-test",
                status: ItemStatus.IN_PROGRESS,
                content: { case: "backgroundTask", value: { taskId: "cleanup-test", command: "fixture" } },
              },
            },
          },
        }),
      ),
    );
    expect(await run({ expectedHeadCommit: next, confirmLocalChanges: true })).toMatchObject({
      ok: false,
      errorCode: "WORKTREE_BUSY",
    });
    await f.runtime.runPromise(
      Journal.use((j) =>
        j.append(t.id, {
          body: {
            case: "itemCompleted",
            value: {
              item: {
                itemId: "bg:cleanup-test",
                status: ItemStatus.COMPLETED,
                content: { case: "backgroundTask", value: { taskId: "cleanup-test", command: "fixture" } },
              },
            },
          },
        }),
      ),
    );
    expect(existsSync(t.cwd)).toBe(true);
  });

  test("new turns cannot race a reserved removal", async () => {
    const t = await f.tree();
    const handle = f.host.handleCommand.bind(f.host);
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    f.host.handleCommand = async (command) => {
      if (command.kind.case === "removeWorktree") {
        reached.resolve();
        await proceed.promise;
      }

      return handle(command);
    };

    const removal = f.remove(t.worktree!.id);

    try {
      await reached.promise;
      expect(
        await failure(f.gw.api.sendMessage({ threadId: t.id, text: "Race", clientRequestId: Bun.randomUUIDv7() })),
      ).toContain("cleanup in progress");
      expect(await failure(f.gw.api.setGoal({ threadId: t.id, action: "set", objective: "Race" }))).toContain(
        "cleanup in progress",
      );
      proceed.resolve();
      expect((await removal).removed).toBe(true);
    } finally {
      proceed.resolve();
      await removal.catch(() => {});
      f.host.handleCommand = handle;
    }
  });

  test("changing the configured root does not strand earlier worktrees", async () => {
    const root = join(f.dir, "custom-root");
    await f.settings({ location: root });
    const t = await f.tree();
    await f.settings({ location: join(f.dir, "new-root") });
    expect((await f.remove(t.worktree!.id)).removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    await f.settings({ location: undefined });
  });

  test("fetch failure keeps the worktree instead of trusting stale merged refs", async () => {
    const t = await f.tree();
    await f.settings({ cleanupMerged: true });
    git(f.repo, "remote", "set-url", "origin", join(f.dir, "missing-origin"));

    try {
      const item = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(item.removed).toBe(false);
      expect(item.detail).not.toBe("Removed");
      expect(existsSync(t.cwd)).toBe(true);
    } finally {
      git(f.repo, "remote", "set-url", "origin", f.origin);
    }
  });

  test.each([false, true])(
    "lost acknowledgement retries once after reconnect (journal result lost: %s)",
    async (lostResult) => {
      const t = await f.tree();
      const handle = f.host.handleCommand.bind(f.host);
      let lost = false;
      f.host.handleCommand = async (command) => {
        const result = await handle(command);

        if (command.kind.case === "removeWorktree" && !lost) {
          lost = true;
          f.disconnect();

          return undefined;
        }

        return result;
      };

      try {
        expect(await failure(f.remove(t.worktree!.id))).toContain("disconnected");
        expect(existsSync(t.cwd)).toBe(false);

        const pending = await f.sql(
          (sql) =>
            sql<{
              removal_token: string | null;
            }>`SELECT removal_token FROM worktrees WHERE id = ${t.worktree!.id}::uuid`,
        );

        expect(pending[0]?.removal_token).toBeTruthy();

        if (lostResult) await f.runtime.runPromise(Journal.use((j) => j.purgeCommands(-1)));
        await f.connect();
        await eventually(
          () => f.gw.api.listWorktrees({}),
          (r) => !r.entries.some((e) => e.worktree?.id === t.worktree!.id),
        );
        expect(
          await f.sql((sql) => sql`SELECT id FROM audit_log WHERE target_id = ${t.worktree!.id}::uuid`),
        ).toHaveLength(1);
      } finally {
        f.host.handleCommand = handle;
      }
    },
  );

  test("worker refuses main checkout, unregistered and symlink-escaped paths even with confirmation", async () => {
    const t = await f.tree();
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    const escaped = join(f.host.worktreesRoot, "escape");
    symlinkSync(outside, escaped);
    const unregistered = join(f.host.worktreesRoot, "unregistered");
    mkdirSync(unregistered);

    for (const path of [f.repo, outside, escaped, unregistered]) {
      const result = await f.host.handleCommand(
        create(CommandSchema, {
          commandId: Bun.randomUUIDv7(),
          kind: {
            case: "removeWorktree",
            value: {
              target: {
                id: t.worktree!.id,
                repoRoot: f.repo,
                path,
                branch: t.worktree!.branch,
                baseRef: "main",
                location: path === f.repo ? f.dir : "",
              },
              confirmLocalChanges: true,
            },
          },
        }),
      );

      expect(result?.ok).toBe(false);
      expect(existsSync(path)).toBe(true);
    }

    expect(existsSync(t.cwd)).toBe(true);
  });

  test("scheduled cleanup commits an already reserved removal while shutting down", async () => {
    const tree = await f.tree();
    await f.settings({ cleanupUnchanged: true });
    const handle = f.host.handleCommand.bind(f.host);
    const removed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.host.handleCommand = async (command) => {
      const result = await handle(command);

      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === tree.worktree!.id) {
        removed.resolve();
        await release.promise;
      }

      return result;
    };

    const schedule = new WorktreeCleanupSchedule(f.gw.core);
    const cleanup = schedule.tick(f.workerId);

    const removal = () =>
      f.sql(
        (sql) => sql<{ finished: boolean }>`SELECT removed_at IS NOT NULL AS finished
      FROM worktrees WHERE id=${tree.worktree!.id}::uuid`,
      );

    try {
      await Promise.race([
        removed.promise,
        cleanup.then(() => {
          throw new Error("Cleanup finished before the worker removed the worktree");
        }),
      ]);
      const shutdown = schedule.stop().then(removal);
      expect(await removal()).toEqual([{ finished: false }]);
      release.resolve();
      expect(await shutdown).toEqual([{ finished: true }]);
    } finally {
      release.resolve();
      await cleanup;
      f.host.handleCommand = handle;
    }
  });

  test("gateway shutdown leaves a scheduled worktree scan for the next cleanup pass", async () => {
    const first = await f.tree();
    const second = await f.tree();
    await f.settings({ cleanupUnchanged: true });
    const handle = f.host.handleCommand.bind(f.host);
    const scanning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let scans = 0;

    f.host.handleCommand = async (command) => {
      const result = await handle(command);

      if (command.kind.case === "scanWorktrees" && command.kind.value.background) {
        scans++;
        scanning.resolve();
        await release.promise;
      }

      return result;
    };

    const cleanup = f.gw.core.worktreeCleanup.tick(f.workerId);
    let stopped: Promise<void> | undefined;

    try {
      await Promise.race([
        scanning.promise,
        cleanup.then(() => {
          throw new Error("Cleanup finished before scanning a worktree");
        }),
      ]);
      let finished = false;
      stopped = f.gw.core.stopSweep().then(() => {
        finished = true;
      });
      expect(await eventually(async () => finished, Boolean, 2000)).toBe(true);
      expect(scans).toBe(1);
      expect(existsSync(first.cwd) && existsSync(second.cwd)).toBe(true);
      expect(await eventually(async () => f.gw.core.link.connections.get(f.workerId)?.idle, Boolean)).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([cleanup, stopped]);
      f.host.handleCommand = handle;
    }
  }, 15_000);
});
