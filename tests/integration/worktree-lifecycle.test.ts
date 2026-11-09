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

    await eventually(
      () => f.gw.api.getThread({ threadId: shared.id }),
      (r) => r.thread?.status === "idle",
    );
    rmSync(join(t.cwd, "worker-started.txt"));
    await f.settings({ cleanupDeletedThreads: true });
    await f.gw.api.deleteThread({ threadId: t.id });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    await f.gw.api.deleteThread({ threadId: shared.id });
    expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
  });

  test("merged policy fetches, verifies ancestry, and deletes only a safe branch when enabled", async () => {
    const t = await f.tree();
    commit(t.cwd, "merged.txt");
    git(t.cwd, "push", "-qu", "origin", t.worktree!.branch);
    await f.settings({ cleanupMerged: true, deleteLocalBranch: true });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    git(f.repo, "merge", "-q", "--no-ff", "-m", "merge", t.worktree!.branch);
    git(f.repo, "push", "-q", "origin", "main");
    const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id);
    expect(removed).toMatchObject({ removed: true, branchDeleted: true });
    expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toBe("");
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

  test("settled policy includes archived threads and respects a live sharing thread", async () => {
    const t = await f.tree();
    await f.settings({ cleanupSettled: true });
    expect((await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)?.wouldRemove).toBe(false);
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
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
    await f.settings({ cleanupSettled: true, keepLocalChanges: false, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
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
    await f.settings({ cleanupSettled: true, deleteLocalBranch: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
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
    await f.connect();
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

  test("gateway refuses removal during queued turns and pending interactions", async () => {
    const t = await f.tree();
    await f.sql(
      (sql) => sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${t.id}::uuid, 1, 'queued', 'user', ${f.gw.userId}::uuid, '{}'::jsonb)`,
    );
    expect((await f.entry(t.worktree!.id)).busy).toBe(true);
    expect(await failure(f.remove(t.worktree!.id, true))).toContain("still using");
    await f.sql((sql) => sql`UPDATE turns SET status = 'completed', last_seq = 1 WHERE thread_id = ${t.id}::uuid`);
    await f.sql(
      (sql) => sql`INSERT INTO interaction_requests (id, thread_id, kind, request, routed_to)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${t.id}::uuid, 'permission', '{}'::jsonb, 'human')`,
    );
    expect((await f.entry(t.worktree!.id)).busy).toBe(true);
    expect(await failure(f.remove(t.worktree!.id, true))).toContain("still using");
    await f.sql(
      (sql) =>
        sql`UPDATE interaction_requests SET status = 'expired', answered_at = now() WHERE thread_id = ${t.id}::uuid`,
    );
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
});
