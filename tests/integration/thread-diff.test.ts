import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CommandSchema,
  ThreadDiffError as Failure,
  ThreadDiffLineKind as Kind,
  ThreadDiffPageSchema,
  type ui,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { GatewayStore } from "@canopy/gateway/store";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { tempDir } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("thread diff over worker, gateway and linked computer", () => {
  const dir = tempDir("canopy-thread-diff-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  const q = (id = thread.id) => qualifyId(id, b.hello().nodeId);

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, { role: "desktop", capabilities: ["thread_diff_v1", "thread_lifecycle_v1"] });
    thread = await home.tree();
    caller = await startTestGateway({ role: "desktop" });

    const connect = (gw: typeof caller) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    a = connect(caller);
    b = connect(home.gw);
    caller.core.computers = a;
    caller.core.network = a.options.network;
    home.gw.core.computers = b;
    home.gw.core.network = b.options.network;
    await a.start();
    await b.start();
    const invitation = await caller.api.createComputerPairing({});
    await home.gw.api.linkComputer({ address: a.addresses[0]!, code: invitation.code });
    await eventually(async () => a.reachable().includes(b.hello().nodeId), Boolean);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
    await caller?.close();
    await home?.close();
  }, 30_000);

  test("combined HEAD diff covers staged and unstaged changes, rename, deletion and binary", async () => {
    commit(thread.cwd, "tracked.txt", "one\ntwo\nthree\n");
    commit(thread.cwd, "removed.txt", "removed\n");
    commit(thread.cwd, "before.txt", "renamed\n");
    writeFileSync(join(thread.cwd, "tracked.txt"), "staged\ntwo\nthree\n");
    git(thread.cwd, "add", "tracked.txt");
    writeFileSync(join(thread.cwd, "tracked.txt"), "staged\nunstaged\nthree\n");
    renameSync(join(thread.cwd, "before.txt"), join(thread.cwd, "after.txt"));
    git(thread.cwd, "add", "before.txt", "after.txt");
    unlinkSync(join(thread.cwd, "removed.txt"));
    writeFileSync(join(thread.cwd, "new.txt"), "new\n");
    writeFileSync(join(thread.cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(home.repo, "outside-thread.txt"), "must not appear");

    const snapshot = await caller.api.listThreadDiff({ threadId: q() });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.error).toBe(Failure.UNSPECIFIED);
    expect(snapshot.files.find((file) => file.path === "after.txt")).toMatchObject({
      status: "R",
      oldPath: "before.txt",
    });
    expect(snapshot.files.find((file) => file.path === "removed.txt")).toMatchObject({ status: "D", deletions: 1 });
    expect(snapshot.files.find((file) => file.path === "new.txt")).toMatchObject({ status: "?", additions: 1 });
    expect(snapshot.files.find((file) => file.path === "binary.bin")?.binary).toBe(true);
    expect(snapshot.files.some((file) => file.path === "outside-thread.txt")).toBe(false);
    const file = snapshot.files.find((entry) => entry.path === "tracked.txt")!;
    expect(file).toMatchObject({ additions: 2, deletions: 2 });

    const page = await caller.api.readThreadDiff({
      threadId: q(),
      snapshotId: snapshot.snapshotId,
      path: file.path,
      limit: 128,
    });

    expect(page.lineCount).toBe(file.lineCount);
    expect(page.lines.filter((line) => line.kind === Kind.ADDITION).map((line) => [line.text, line.newLine])).toEqual([
      ["staged", 1],
      ["unstaged", 2],
    ]);
    expect(page.lines.filter((line) => line.kind === Kind.DELETION).map((line) => line.text)).toEqual(["one", "two"]);
  });

  test("one million changed lines are disk paged with stable reads after edits", async () => {
    const original = "long\n".repeat(1_000_000);
    writeFileSync(join(thread.cwd, "million.txt"), original);
    const snapshot = await caller.api.listThreadDiff({ threadId: q() });
    expect(snapshot.complete).toBe(true);
    const file = snapshot.files.find((entry) => entry.path === "million.txt")!;
    expect(file.additions).toBe(1_000_000);
    expect(file.lineCount).toBeGreaterThanOrEqual(1_000_000);
    writeFileSync(join(thread.cwd, "million.txt"), "changed after snapshot\n");

    for (const offset of [0, 127, 500_000, file.lineCount - 2]) {
      const page = await caller.api.readThreadDiff({
        threadId: q(),
        snapshotId: snapshot.snapshotId,
        path: file.path,
        offset,
        limit: 128,
      });

      expect(page.error).toBe(Failure.UNSPECIFIED);
      expect(page.offset).toBe(offset);
      expect(page.lineCount).toBe(file.lineCount);
      expect(page.lines.length).toBe(Math.min(128, file.lineCount - offset));
      expect(toBinary(ThreadDiffPageSchema, page).byteLength).toBeLessThan(64 * 1024);
      expect(page.lines.filter((line) => line.kind === Kind.ADDITION).every((line) => line.text === "long")).toBe(true);
    }

    unlinkSync(join(thread.cwd, "million.txt"));
  }, 40_000);

  test("refresh replaces snapshots without exhausting capacity and coalesces concurrent callers", async () => {
    for (let index = 0; index < 6; index++) {
      const snapshot = await home.gw.api.listThreadDiff({ threadId: thread.id });
      expect(snapshot.complete).toBe(true);
    }

    const snapshots = await Promise.all(
      Array.from({ length: 3 }, () => home.gw.api.listThreadDiff({ threadId: thread.id })),
    );

    expect(new Set(snapshots.map((snapshot) => snapshot.snapshotId)).size).toBe(1);
    expect(snapshots.every((snapshot) => snapshot.complete)).toBe(true);
  });

  test("switching between more than four threads evicts old snapshots instead of blocking", async () => {
    const snapshots: { threadId: string; snapshotId: string; path: string }[] = [];

    for (let index = 0; index < 5; index++) {
      const selected = await home.tree();
      writeFileSync(join(selected.cwd, "change.txt"), "changed\n");
      const snapshot = await home.gw.api.listThreadDiff({ threadId: selected.id });
      expect(snapshot.complete).toBe(true);
      snapshots.push({ threadId: selected.id, snapshotId: snapshot.snapshotId, path: "change.txt" });
    }

    expect((await home.gw.api.readThreadDiff(snapshots[0]!)).error).toBe(Failure.SNAPSHOT_EXPIRED);
    expect((await home.gw.api.readThreadDiff(snapshots.at(-1)!)).error).toBe(Failure.UNSPECIFIED);
    expect((await home.gw.api.listThreadDiff({ threadId: snapshots[0]!.threadId })).complete).toBe(true);
  });

  test("staged deletion plus untracked recreation is one combined file", async () => {
    commit(thread.cwd, "recreated.txt", "old\n");
    git(thread.cwd, "rm", "recreated.txt");
    writeFileSync(join(thread.cwd, "recreated.txt"), "new\n");
    const snapshot = await home.gw.api.listThreadDiff({ threadId: thread.id });
    expect(snapshot.files.filter((file) => file.path === "recreated.txt")).toHaveLength(1);
    expect(snapshot.files.find((file) => file.path === "recreated.txt")).toMatchObject({
      status: "M",
      additions: 1,
      deletions: 1,
    });
  });

  test("another owner cannot dispatch reads locally or through the linked home", async () => {
    const owner = await home.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("diff-private@example.test", "Other owner")),
    );

    const id = Bun.randomUUIDv7();
    await home.sql(
      (sql) => sql`
      INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, depth, runtime, provider, worker_id, workspace_id, cwd, title, status)
      SELECT ${id}::uuid, project_id, ${owner}::uuid, 'main', ${id}::uuid, 0, runtime, provider, worker_id, workspace_id, cwd, 'Private diff', 'idle'
      FROM threads WHERE id=${thread.id}::uuid
    `,
    );

    for (const [api, threadId] of [
      [home.gw.api, id],
      [caller.api, q(id)],
    ] as const) {
      expect(await failure(api.listThreadDiff({ threadId }))).toContain("Thread unavailable");
      expect(
        await failure(api.readThreadDiff({ threadId, snapshotId: crypto.randomUUID(), path: "tracked.txt" })),
      ).toContain("Thread unavailable");
    }
  });

  test("snapshots are bound to owner and thread; traversal and links never expose outside bytes", async () => {
    const outside = join(dir, "private.txt");
    writeFileSync(outside, "private file contents");
    symlinkSync(outside, join(thread.cwd, "link.txt"));
    const snapshot = await caller.api.listThreadDiff({ threadId: q() });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.find((file) => file.path === "link.txt")?.binary).toBe(true);
    const link = await caller.api.readThreadDiff({ threadId: q(), snapshotId: snapshot.snapshotId, path: "link.txt" });
    expect(link.lines.map((line) => line.text).join("\n")).not.toContain(outside);
    expect(link.lines.map((line) => line.text).join("\n")).not.toContain("private file contents");

    for (const path of ["../private.txt", outside, ".git/config", "C:\\private", "a/../../b"])
      expect(
        await failure(caller.api.readThreadDiff({ threadId: q(), snapshotId: snapshot.snapshotId, path })),
      ).toBeTruthy();
    const other = await home.tree();
    expect(
      (await caller.api.readThreadDiff({ threadId: q(other.id), snapshotId: snapshot.snapshotId, path: "tracked.txt" }))
        .error,
    ).toBe(Failure.SNAPSHOT_EXPIRED);

    const raw = await home.host.handleCommand(
      create(CommandSchema, {
        commandId: crypto.randomUUID(),
        kind: {
          case: "readThreadDiff",
          value: {
            ownerId: "another-owner",
            threadId: thread.id,
            workspace: thread.cwd,
            snapshotId: snapshot.snapshotId,
            path: "tracked.txt",
          },
        },
      }),
    );

    expect(raw?.threadDiffPage?.error).toBe(Failure.SNAPSHOT_EXPIRED);
  });

  test("unborn index, empty files, mode changes and staged removals remain complete", async () => {
    const empty = await home.tree();
    git(empty.cwd, "checkout", "--orphan", "unborn-diff");
    git(empty.cwd, "rm", "-rf", ".");
    writeFileSync(join(empty.cwd, "staged.txt"), "staged\n");
    writeFileSync(join(empty.cwd, "gone.txt"), "gone\n");
    writeFileSync(join(empty.cwd, "empty.txt"), "");
    git(empty.cwd, "add", ".");
    unlinkSync(join(empty.cwd, "gone.txt"));
    const unborn = await home.gw.api.listThreadDiff({ threadId: empty.id });
    expect(unborn.complete).toBe(true);
    expect(unborn.files.some((file) => file.path === "gone.txt")).toBe(false);
    expect(unborn.files.find((file) => file.path === "staged.txt")).toMatchObject({ status: "A", additions: 1 });
    expect(unborn.files.find((file) => file.path === "empty.txt")?.lineCount).toBeGreaterThan(0);
    commit(thread.cwd, "mode-only.txt", "mode\n");
    chmodSync(join(thread.cwd, "mode-only.txt"), 0o755);
    const mode = await home.gw.api.listThreadDiff({ threadId: thread.id });
    expect(mode.complete).toBe(true);
    const tracked = mode.files.find((file) => file.path === "mode-only.txt")!;

    const page = await home.gw.api.readThreadDiff({
      threadId: thread.id,
      snapshotId: mode.snapshotId,
      path: tracked.path,
    });

    expect(page.lines.some((line) => line.kind === Kind.META && line.text.includes("File mode changed"))).toBe(true);
  });

  test("merge conflicts remain explicit and only the thread cwd is compared", async () => {
    const conflicted = await home.tree();
    commit(conflicted.cwd, "conflict.txt", "base\n");
    const base = git(conflicted.cwd, "rev-parse", "HEAD");
    git(conflicted.cwd, "checkout", "-b", "diff-conflict-side");
    commit(conflicted.cwd, "conflict.txt", "side\n");
    const side = git(conflicted.cwd, "rev-parse", "HEAD");
    git(conflicted.cwd, "checkout", "--detach", base);
    commit(conflicted.cwd, "conflict.txt", "ours\n");
    const merge = Bun.spawnSync(["git", "merge", "--no-edit", side], { cwd: conflicted.cwd });
    expect(merge.exitCode).toBe(1);
    const snapshot = await home.gw.api.listThreadDiff({ threadId: conflicted.id });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.find((file) => file.path === "conflict.txt")?.status).toBe("U");

    const page = await home.gw.api.readThreadDiff({
      threadId: conflicted.id,
      snapshotId: snapshot.snapshotId,
      path: "conflict.txt",
    });

    expect(page.lines.some((line) => line.kind === Kind.META && line.text === "Merge conflict")).toBe(true);

    const nested = join(thread.cwd, "nested-scope");
    mkdirSync(nested);
    writeFileSync(join(nested, "inside.txt"), "inside\n");

    const raw = await home.host.handleCommand(
      create(CommandSchema, {
        commandId: crypto.randomUUID(),
        kind: {
          case: "listThreadDiff",
          value: { ownerId: home.gw.userId, threadId: thread.id, workspace: nested },
        },
      }),
    );

    expect(raw?.ok).toBe(true);
    expect(raw?.threadDiff?.complete).toBe(true);
    expect(raw?.threadDiff?.files.map((file) => file.path)).toEqual(["inside.txt"]);
  });

  test("Git display settings cannot shift comment line numbers or break blank context", async () => {
    const selected = await home.tree();
    commit(selected.cwd, "blank.txt", "a\n\nb\nc\n");
    writeFileSync(join(selected.cwd, "blank.txt"), "a\n\nb\nchanged\n");
    git(selected.cwd, "config", "diff.suppressBlankEmpty", "true");

    try {
      const snapshot = await home.gw.api.listThreadDiff({ threadId: selected.id });

      const page = await home.gw.api.readThreadDiff({
        threadId: selected.id,
        snapshotId: snapshot.snapshotId,
        path: "blank.txt",
      });

      expect(page.lines.find((line) => line.kind === Kind.CONTEXT && line.text === "")).toMatchObject({
        oldLine: 2,
        newLine: 2,
      });
      expect(page.lines.find((line) => line.kind === Kind.ADDITION)).toMatchObject({ text: "changed", newLine: 4 });
      expect(page.lines.find((line) => line.kind === Kind.DELETION)).toMatchObject({ text: "c", oldLine: 4 });
    } finally {
      git(selected.cwd, "config", "--unset", "diff.suppressBlankEmpty");
    }
  });

  test("embedded untracked repositories have metadata without blocking ordinary files", async () => {
    const selected = await home.tree();
    const nested = join(selected.cwd, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeFileSync(join(selected.cwd, "ordinary.txt"), "ordinary\n");
    const snapshot = await home.gw.api.listThreadDiff({ threadId: selected.id });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.files.find((file) => file.path === "ordinary.txt")).toMatchObject({ additions: 1 });
    expect(snapshot.files.find((file) => file.path === "nested")).toMatchObject({ binary: true, lineCount: 1 });
    expect(snapshot.files.some((file) => file.path.includes(".git"))).toBe(false);
  });

  test("diff reads never execute repository or global clean/process filters", async () => {
    const selected = await home.tree();
    commit(
      selected.cwd,
      ".gitattributes",
      "local.txt filter=local-marker\nglobal.txt filter=global-marker\nprocess.txt filter=process-marker\n",
    );

    for (const path of ["local.txt", "global.txt", "process.txt"]) commit(selected.cwd, path, "original\n");
    git(selected.cwd, "config", "filter.local-marker.clean", "touch filter-local-ran; cat");
    git(selected.cwd, "config", "filter.local-marker.required", "true");
    git(selected.cwd, "config", "filter.process-marker.process", "touch filter-process-ran; exit 1");
    git(selected.cwd, "config", "filter.process-marker.required", "true");
    const configuration = join(dir, "filter-global.config");
    writeFileSync(configuration, "");
    git(selected.cwd, "config", "--file", configuration, "filter.global-marker.clean", "touch filter-global-ran; cat");
    git(selected.cwd, "config", "--file", configuration, "filter.global-marker.required", "true");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = configuration;

    try {
      for (const path of ["local.txt", "global.txt", "process.txt"])
        writeFileSync(join(selected.cwd, path), "changed without filters\n");
      const snapshot = await caller.api.listThreadDiff({ threadId: q(selected.id) });
      expect(snapshot.complete).toBe(true);

      for (const path of ["local.txt", "global.txt", "process.txt"]) {
        const page = await caller.api.readThreadDiff({
          threadId: q(selected.id),
          snapshotId: snapshot.snapshotId,
          path,
        });

        expect(page.lines.find((line) => line.kind === Kind.ADDITION)?.text).toBe("changed without filters");
      }

      for (const path of ["filter-local-ran", "filter-global-ran", "filter-process-ran"])
        expect(existsSync(join(selected.cwd, path))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
      git(selected.cwd, "config", "--remove-section", "filter.local-marker");
      git(selected.cwd, "config", "--remove-section", "filter.process-marker");
    }
  });

  test("archived threads can refresh and read diff after lifecycle cleanup, while deleted threads stay blocked", async () => {
    const selected = await home.tree();
    writeFileSync(join(selected.cwd, "archived.txt"), "available after archive\n");
    const before = await caller.api.listThreadDiff({ threadId: q(selected.id) });
    expect(before.complete).toBe(true);
    await caller.api.setThreadArchived({ threadId: q(selected.id), archived: true });
    await eventually(async () => home.host.threadClosed(selected.id), Boolean);
    await eventually(
      () =>
        home.sql(
          (sql) =>
            sql<{
              status: string;
            }>`SELECT status FROM worker_commands WHERE thread_id=${selected.id}::uuid AND kind='unloadThread'`,
        ),
      (rows) => rows[0]?.status === "completed",
    );

    for (const [api, threadId] of [
      [home.gw.api, selected.id],
      [caller.api, q(selected.id)],
    ] as const) {
      const expired = await api.readThreadDiff({ threadId, snapshotId: before.snapshotId, path: "archived.txt" });
      expect(expired.error).toBe(Failure.SNAPSHOT_EXPIRED);
      const snapshot = await api.listThreadDiff({ threadId });
      expect(snapshot.complete).toBe(true);
      expect(snapshot.files.find((file) => file.path === "archived.txt")).toMatchObject({ additions: 1 });
      const page = await api.readThreadDiff({ threadId, snapshotId: snapshot.snapshotId, path: "archived.txt" });
      expect(page.error).toBe(Failure.UNSPECIFIED);
      expect(page.lines.find((line) => line.kind === Kind.ADDITION)?.text).toBe("available after archive");
    }

    expect(home.host.threadClosed(selected.id)).toBe(true);
    await caller.api.deleteThread({ threadId: q(selected.id) });
    expect(await failure(caller.api.listThreadDiff({ threadId: q(selected.id) }))).toMatch(
      /thread not found|Thread unavailable/,
    );
    expect(
      await failure(
        caller.api.readThreadDiff({ threadId: q(selected.id), snapshotId: before.snapshotId, path: "archived.txt" }),
      ),
    ).toMatch(/thread not found|Thread unavailable/);
  }, 30_000);

  test("resource limits are explicit and restart expires retained snapshots", async () => {
    writeFileSync(join(thread.cwd, "oversize.txt"), "x".repeat(60 * 1024));
    const failed = await caller.api.listThreadDiff({ threadId: q() });
    expect(failed).toMatchObject({ complete: false, error: Failure.TOO_LARGE, files: [], snapshotId: "" });
    unlinkSync(join(thread.cwd, "oversize.txt"));
    const snapshot = await caller.api.listThreadDiff({ threadId: q() });
    const capabilities = home.gw.core.link.connections.get(home.workerId)!.hello.capabilities;
    home.gw.core.link.connections.get(home.workerId)!.hello.capabilities = capabilities.filter(
      (value) => value !== "thread_diff_v1",
    );

    try {
      expect(await failure(caller.api.listThreadDiff({ threadId: q() }))).toContain("Update Canopy");
    } finally {
      home.gw.core.link.connections.get(home.workerId)!.hello.capabilities = capabilities;
    }

    await home.restart();
    expect(
      (await caller.api.readThreadDiff({ threadId: q(), snapshotId: snapshot.snapshotId, path: "tracked.txt" })).error,
    ).toBe(Failure.SNAPSHOT_EXPIRED);
  });
});
