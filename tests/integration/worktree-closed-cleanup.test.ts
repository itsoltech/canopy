import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Journal } from "@canopy/worker/journal";
import { Effect } from "effect";
import { eventually, failure } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("closed-thread worktree cleanup over gRPC", () => {
  const dir = tempDir("canopy-worktree-closed-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir);
    commit(f.repo, ".gitignore", ".cache/\n");
    git(f.repo, "push", "-q", "origin", "main");
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
      deleteLocalBranch: true,
    });
  });

  const closeThread = (id: string, closed: string) =>
    closed === "archived"
      ? f.gw.api.setThreadArchived({ threadId: id, archived: true })
      : f.gw.api.deleteThread({ threadId: id });

  const enableClosed = (closed: string) =>
    f.settings({ cleanupSettled: closed === "archived", cleanupDeletedThreads: closed === "deleted" });

  test.each(["unchanged", "merged", "archived", "deleted", "inactive", "manual"])(
    "ignored files do not require confirmation or prevent %s removal and branch deletion",
    async (rule) => {
      const t = await f.tree();
      mkdirSync(join(t.cwd, ".cache"));
      writeFileSync(join(t.cwd, ".cache", "output.txt"), "ignored build output");
      expect(git(t.cwd, "status", "--porcelain", "--ignored")).toContain("!! .cache/");
      await f.settings({
        cleanupUnchanged: rule === "unchanged",
        cleanupMerged: rule === "merged",
        cleanupSettled: rule === "archived",
        cleanupDeletedThreads: rule === "deleted",
        cleanupInactiveDays: rule === "inactive" ? 7 : 0,
      });

      if (rule === "archived" || rule === "deleted") await closeThread(t.id, rule);

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

      const preview = (await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(preview.status).toMatchObject({ dirtyFiles: 0, unchanged: true, unpushed: false });
      expect(preview.confirmationRequired).toBe(false);
      expect(preview.wouldRemove).toBe(rule !== "manual");
      expect(existsSync(join(t.cwd, ".cache", "output.txt"))).toBe(true);

      const removed =
        rule === "manual"
          ? await f.remove(t.worktree!.id)
          : (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id);

      expect(removed).toMatchObject({ removed: true, branchDeleted: true });
      expect(existsSync(t.cwd)).toBe(false);
      expect(git(f.repo, "branch", "--list", t.worktree!.branch)).toBe("");
    },
  );

  for (const closed of ["archived", "deleted"]) {
    test.each(["tracked", "untracked", "unpushed", "mixed"])(
      `${closed} cleanup discards %s work while preserving the local branch`,
      async (changes) => {
        const t = await f.tree();
        const unpushed = changes === "unpushed" || changes === "mixed";

        const head = unpushed
          ? commit(t.cwd, "local-commit.txt", "recoverable commit\n")
          : git(t.cwd, "rev-parse", "HEAD");

        if (changes === "tracked" || changes === "mixed") writeFileSync(join(t.cwd, "README.md"), "tracked edits\n");

        if (changes === "untracked" || changes === "mixed")
          writeFileSync(join(t.cwd, "local.txt"), "untracked edits\n");
        await enableClosed(closed);
        await closeThread(t.id, closed);
        const preview = (await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
        const dirtyFiles = changes === "mixed" ? 2 : Number(changes !== "unpushed");
        expect(preview.status).toMatchObject({
          dirtyFiles,
          unpushed,
        });
        expect(preview).toMatchObject({
          confirmationRequired: true,
          wouldRemove: true,
          detail: `All threads ${closed}`,
        });
        expect(existsSync(t.cwd)).toBe(true);
        expect(await failure(f.remove(t.worktree!.id))).toContain("explicit confirmation");
        const removed = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id);
        expect(removed).toMatchObject({ removed: true, branchDeleted: false });
        expect(existsSync(t.cwd)).toBe(false);
        expect(git(f.repo, "rev-parse", t.worktree!.branch)).toBe(head);

        if (unpushed) expect(git(f.repo, "show", `${t.worktree!.branch}:local-commit.txt`)).toBe("recoverable commit");
      },
    );

    test(`${closed} threads require their enabled rule to discard local work`, async () => {
      const t = await f.tree();
      writeFileSync(join(t.cwd, "local.txt"), "protected without the lifecycle rule\n");
      await f.settings({ cleanupMerged: true, keepLocalChanges: false });
      await closeThread(t.id, closed);
      const preview = (await f.cleanup()).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(preview.status).toMatchObject({ merged: true, dirtyFiles: 1 });
      expect(preview).toMatchObject({ wouldRemove: false, confirmationRequired: true });
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
      expect(await failure(f.remove(t.worktree!.id))).toContain("explicit confirmation");
      expect(readFileSync(join(t.cwd, "local.txt"), "utf8")).toBe("protected without the lifecycle rule\n");
      await enableClosed(closed);
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
    });

    test(`${closed} threads with a paused goal are eligible without becoming busy`, async () => {
      const t = await f.tree();
      await f.sql(
        (sql) => sql`INSERT INTO goals(id,thread_id,objective,status,created_by,created_by_user_id)
        VALUES (${Bun.randomUUIDv7()}::uuid,${t.id}::uuid,'Paused work','paused','user',${f.gw.userId}::uuid)`,
      );
      expect((await f.entry(t.worktree!.id)).busy).toBe(true);
      await enableClosed(closed);
      await closeThread(t.id, closed);
      expect(await f.entry(t.worktree!.id)).toMatchObject({
        busy: false,
        wouldRemove: true,
        detail: `All threads ${closed}`,
      });
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
    });

    test(`${closed} cleanup reserves against reopening, then permits restoring removed history`, async () => {
      const t = await f.tree();
      writeFileSync(join(t.cwd, "local.txt"), "discard with closed-thread consent\n");
      await enableClosed(closed);
      await closeThread(t.id, closed);
      const handle = f.host.handleCommand.bind(f.host);
      let checked = false;
      f.host.handleCommand = async (command) => {
        if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === t.worktree!.id) {
          checked = true;
          expect(command.kind.value.confirmLocalChanges).toBe(true);

          const reopen =
            closed === "archived"
              ? f.gw.api.setThreadArchived({ threadId: t.id, archived: false })
              : f.gw.api.restoreThread({ threadId: t.id });

          expect(await failure(reopen)).toContain("Worktree cleanup is in progress");
        }

        return handle(command);
      };

      try {
        expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
        expect(checked).toBe(true);
      } finally {
        f.host.handleCommand = handle;
      }

      if (closed === "archived") await f.gw.api.setThreadArchived({ threadId: t.id, archived: false });
      else await f.gw.api.restoreThread({ threadId: t.id });
      expect((await f.gw.api.getThread({ threadId: t.id })).thread?.worktree?.removedAt).toBeDefined();
      expect(existsSync(t.cwd)).toBe(false);
    });
  }

  test.each(["archived", "deleted"])(
    "an open sharing thread prevents disposal after its peer is %s",
    async (closed) => {
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
      writeFileSync(join(t.cwd, "local.txt"), "shared local work\n");
      await f.settings({ cleanupSettled: true, cleanupDeletedThreads: true, cleanupMerged: true });
      await closeThread(t.id, closed);
      expect(await f.entry(t.worktree!.id)).toMatchObject({ wouldRemove: false, confirmationRequired: true });
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(false);
      expect(existsSync(join(t.cwd, "local.txt"))).toBe(true);
      await f.gw.api.setThreadArchived({ threadId: shared.id, archived: true });
      expect(await f.entry(t.worktree!.id)).toMatchObject({ wouldRemove: true, detail: "All threads archived" });
      expect((await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)?.removed).toBe(true);
    },
  );

  test("unarchive after scan revokes disposal even when merged cleanup still matches", async () => {
    const t = await f.tree();
    writeFileSync(join(t.cwd, "local.txt"), "must survive reopening\n");
    await f.settings({ cleanupSettled: true, cleanupMerged: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    expect(await f.entry(t.worktree!.id)).toMatchObject({ wouldRemove: true, confirmationRequired: true });
    const handle = f.host.handleCommand.bind(f.host);
    let reopened = false;
    let removals = 0;
    let reservations = 0;
    const store = await f.gw.runtime.runPromise(GatewayStore);
    const reserve = store.reserveWorktreeRemoval;

    // Observe the transaction boundary: cancelling a committed disposal command later is too late.
    const reservation = spyOn(store, "reserveWorktreeRemoval").mockImplementation((...args) =>
      reserve(...args).pipe(
        Effect.tap((row) =>
          Effect.sync(() => {
            if (row.id === t.worktree!.id) reservations++;
          }),
        ),
      ),
    );

    f.host.handleCommand = async (command) => {
      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === t.worktree!.id) removals++;
      const result = await handle(command);

      if (
        !reopened &&
        command.kind.case === "scanWorktrees" &&
        command.kind.value.fetch &&
        command.kind.value.targets.some((target) => target.id === t.worktree!.id)
      ) {
        reopened = true;
        await f.gw.api.setThreadArchived({ threadId: t.id, archived: false });
      }

      return result;
    };

    try {
      const result = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(reopened).toBe(true);
      expect(result).toMatchObject({ removed: false, detail: "The cleanup policy no longer matches" });
      expect(reservations).toBe(0);
      expect(removals).toBe(0);
      expect(await f.entry(t.worktree!.id)).toMatchObject({
        confirmationRequired: true,
        wouldRemove: false,
        status: expect.objectContaining({ merged: true }),
      });

      const rows = await f.sql(
        (sql) =>
          sql<{ removal_token: string | null; removal_command: Uint8Array | null }>`
          SELECT removal_token,removal_command FROM worktrees WHERE id=${t.worktree!.id}::uuid`,
      );

      expect(rows[0]).toMatchObject({ removal_token: null, removal_command: null });
      expect(readFileSync(join(t.cwd, "local.txt"), "utf8")).toBe("must survive reopening\n");
    } finally {
      f.host.handleCommand = handle;
      reservation.mockRestore();
    }
  });

  test("worker rejects HEAD changes after closed-thread cleanup is reserved", async () => {
    const t = await f.tree();
    writeFileSync(join(t.cwd, "local.txt"), "discard only at the scanned HEAD\n");
    await f.settings({ cleanupSettled: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });
    const handle = f.host.handleCommand.bind(f.host);
    let changed = false;
    f.host.handleCommand = async (command) => {
      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === t.worktree!.id) {
        changed = true;
        expect(command.kind.value.confirmLocalChanges).toBe(true);
        commit(t.cwd, "after-reservation.txt", "new work after scan\n");
      }

      return handle(command);
    };

    try {
      const result = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(changed).toBe(true);
      expect(result.removed).toBe(false);
      expect(result.detail).toContain("worktree changed");
      expect(existsSync(join(t.cwd, "local.txt"))).toBe(true);
      expect(existsSync(join(t.cwd, "after-reservation.txt"))).toBe(true);
    } finally {
      f.host.handleCommand = handle;
    }
  });

  test("active worker background tasks block closed-thread cleanup despite its disposal consent", async () => {
    const t = await f.tree();
    writeFileSync(join(t.cwd, "local.txt"), "discard only while idle\n");
    await f.settings({ cleanupSettled: true });
    await f.gw.api.setThreadArchived({ threadId: t.id, archived: true });

    // Inject after unload has finished closing orphan tasks, so the worker sees genuinely new activity.
    const unloaded = await eventually(
      () =>
        f.sql(
          (sql) => sql<{ status: string }>`SELECT status FROM worker_commands
          WHERE thread_id=${t.id}::uuid AND kind='unloadThread' ORDER BY created_at DESC LIMIT 1`,
        ),
      (rows) => rows[0]?.status === "completed",
    );

    expect(unloaded[0]?.status).toBe("completed");
    const handle = f.host.handleCommand.bind(f.host);
    let checked = false;
    f.host.handleCommand = async (command) => {
      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === t.worktree!.id) {
        checked = true;
        await f.runtime.runPromise(
          Journal.use((j) =>
            j.append(t.id, {
              body: {
                case: "itemStarted",
                value: {
                  item: {
                    itemId: "bg:closed-cleanup",
                    status: ItemStatus.IN_PROGRESS,
                    content: { case: "backgroundTask", value: { taskId: "closed-cleanup", command: "fixture" } },
                  },
                },
              },
            }),
          ),
        );
      }

      return handle(command);
    };

    try {
      const result = (await f.cleanup(false)).entries.find((e) => e.worktree?.id === t.worktree!.id)!;
      expect(checked).toBe(true);
      expect(result.removed).toBe(false);
      expect(result.detail).toContain("still using");
      expect(existsSync(join(t.cwd, "local.txt"))).toBe(true);
    } finally {
      f.host.handleCommand = handle;
      await f.runtime.runPromise(
        Journal.use((j) =>
          j.append(t.id, {
            body: {
              case: "itemCompleted",
              value: {
                item: {
                  itemId: "bg:closed-cleanup",
                  status: ItemStatus.COMPLETED,
                  content: { case: "backgroundTask", value: { taskId: "closed-cleanup", command: "fixture" } },
                },
              },
            },
          }),
        ),
      );
    }
  });
});
