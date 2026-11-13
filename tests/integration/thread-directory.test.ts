import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  CommandSchema,
  ThreadDirectoryPageSchema,
  ThreadDirectoryKind as Kind,
  ThreadDirectoryError as Failure,
  type ui,
} from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("bounded thread directory over gateway, worker and computer link", () => {
  const dir = tempDir("canopy-thread-directory-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  const q = (id = thread.id) => qualifyId(id, b.hello().nodeId);

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, {
      role: "desktop",
      capabilities: ["thread_directory_v1", "thread_files_v1", "thread_file_preview_v1"],
    });
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

  test("the tree uses the thread worktree, including through the linked home", async () => {
    writeFileSync(join(home.repo, "source-only.txt"), "source");
    mkdirSync(join(thread.cwd, "folder"));
    writeFileSync(join(thread.cwd, "folder", "nested.txt"), "thread bytes");

    for (const [api, threadId] of [
      [home.gw.api, thread.id],
      [caller.api, q()],
    ] as const) {
      const page = await api.listThreadDirectory({ threadId });
      expect(page.entries.some((entry) => entry.name === "source-only.txt")).toBe(false);
      expect(page.entries.find((entry) => entry.name === "folder")?.kind).toBe(Kind.DIRECTORY);
      expect(page.entries.some((entry) => entry.path.includes("nested.txt"))).toBe(false);
      expect(page.rootIdentity).toMatch(/^[a-f0-9]{64}$/);
      const nested = await api.listThreadDirectory({ threadId, directory: "folder" });
      expect(nested.entries[0]).toMatchObject({
        name: "nested.txt",
        path: "folder/nested.txt",
        kind: Kind.FILE,
        size: 12n,
      });
      expect(
        new TextDecoder().decode((await api.readThreadFile({ threadId, path: "folder/nested.txt" })).content),
      ).toBe("thread bytes");
    }
  });

  test("a 10,000-child folder stays paginated and below the protobuf envelope budget", async () => {
    const many = join(thread.cwd, "many");
    mkdirSync(many);

    for (let index = 0; index < 10_000; index++)
      writeFileSync(join(many, `${String(index).padStart(5, "0")}-${"x".repeat(235)}.txt`), "");
    const names = new Set<string>();
    let token = "";
    let revision = "";
    let pages = 0;

    do {
      const page = await caller.api.listThreadDirectory({
        threadId: q(),
        directory: "many",
        pageSize: 1000,
        pageToken: token,
        knownRevision: revision,
      });

      expect(page.error).toBe(Failure.UNSPECIFIED);
      expect(page.entries.length).toBeLessThanOrEqual(200);
      expect(toBinary(ThreadDirectoryPageSchema, page).byteLength + 256).toBeLessThanOrEqual(64 * 1024);

      for (const entry of page.entries) {
        expect(names.has(entry.path)).toBe(false);
        names.add(entry.path);
      }

      token = page.nextPageToken;
      revision = page.directoryRevision;
      pages++;
      expect(pages).toBeLessThan(150);
    } while (token);

    expect(names.size).toBe(10_000);
    expect(pages).toBeGreaterThan(50);
  }, 30_000);

  test("cursor replay, changed filters and another thread cannot consume a retained iterator", async () => {
    const first = await caller.api.listThreadDirectory({ threadId: q(), directory: "many", pageSize: 1 });

    const filtered = await caller.api.listThreadDirectory({
      threadId: q(),
      directory: "many",
      pageToken: first.nextPageToken,
      includeIgnored: true,
    });

    expect(filtered.error).toBe(Failure.CURSOR_EXPIRED);
    expect(filtered.entries).toEqual([]);
    const other = await home.tree();

    const foreign = await caller.api.listThreadDirectory({
      threadId: q(other.id),
      directory: "",
      pageToken: first.nextPageToken,
    });

    expect(foreign.error).toBe(Failure.CURSOR_EXPIRED);

    const next = await caller.api.listThreadDirectory({
      threadId: q(),
      directory: "many",
      pageSize: 1,
      pageToken: first.nextPageToken,
    });

    expect(next.entries).toHaveLength(1);
    expect(
      (await caller.api.listThreadDirectory({ threadId: q(), directory: "many", pageToken: first.nextPageToken }))
        .error,
    ).toBe(Failure.CURSOR_EXPIRED);
    await caller.api.listThreadDirectory({
      threadId: q(),
      directory: "many",
      pageToken: next.nextPageToken,
      release: true,
    });
    expect(
      (await caller.api.listThreadDirectory({ threadId: q(), directory: "many", pageToken: next.nextPageToken })).error,
    ).toBe(Failure.CURSOR_EXPIRED);
  });

  test("directory changes invalidate the cursor rather than silently duplicating names", async () => {
    const first = await caller.api.listThreadDirectory({ threadId: q(), directory: "many", pageSize: 1 });
    writeFileSync(join(thread.cwd, "many", "added.txt"), "new");

    const changed = await caller.api.listThreadDirectory({
      threadId: q(),
      directory: "many",
      pageToken: first.nextPageToken,
    });

    expect(changed.error).toBe(Failure.DIRECTORY_CHANGED);
    expect(changed.entries).toEqual([]);
  });

  test("gateway rejects another owner before dispatching a listing locally or through a home", async () => {
    const owner = await home.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("directory-owner@example.test", "Other owner")),
    );

    const id = Bun.randomUUIDv7();
    await home.sql(
      (sql) => sql`
      INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, depth, runtime, provider, worker_id, workspace_id, cwd, title, status)
      SELECT ${id}::uuid, project_id, ${owner}::uuid, 'main', ${id}::uuid, 0, runtime, provider, worker_id, workspace_id, cwd, 'Private tree', 'idle'
      FROM threads WHERE id=${thread.id}::uuid
    `,
    );

    for (const [api, threadId] of [
      [home.gw.api, id],
      [caller.api, q(id)],
    ] as const)
      expect(await failure(api.listThreadDirectory({ threadId }))).toContain("Thread unavailable");
  });

  test("traversal, absolute roots and symlink traversal are refused; symlink targets never leave the worker", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "private");
    symlinkSync(outside, join(thread.cwd, "escape"));
    const page = await caller.api.listThreadDirectory({ threadId: q() });
    expect(page.entries.find((entry) => entry.name === "escape")).toMatchObject({ kind: Kind.SYMLINK, path: "escape" });
    expect(toJsonString(ThreadDirectoryPageSchema, page)).not.toContain(outside);

    for (const directory of ["..", "folder/../../outside", "..\\outside", outside, "C:\\outside", ".git", "escape"])
      expect(await failure(caller.api.listThreadDirectory({ threadId: q(), directory }))).toBeTruthy();

    const raw = await home.host.handleCommand(
      create(CommandSchema, {
        commandId: Bun.randomUUIDv7(),
        kind: {
          case: "listThreadDirectory",
          value: {
            ownerId: home.gw.userId,
            threadId: thread.id,
            workspace: thread.cwd,
            directory: "escape",
          },
        },
      }),
    );

    expect(raw?.ok).toBe(false);
    expect(raw?.threadDirectory?.entries ?? []).toEqual([]);
  });

  test("git modifications, rename, deletion and ignored folders are explicit without per-file status calls", async () => {
    commit(thread.cwd, "old.txt", "old");
    commit(thread.cwd, "removed.txt", "remove");
    commit(thread.cwd, ".gitignore", "ignored/\n");
    renameSync(join(thread.cwd, "old.txt"), join(thread.cwd, "renamed.txt"));
    git(thread.cwd, "add", "old.txt", "renamed.txt");
    unlinkSync(join(thread.cwd, "removed.txt"));
    writeFileSync(join(thread.cwd, "README.md"), "modified");
    mkdirSync(join(thread.cwd, "ignored"));
    writeFileSync(join(thread.cwd, "ignored", "secret.txt"), "local");

    // Status cache has a two-second bound; wait on real RPC facts rather than sleeping.
    const page = await eventually(
      () => caller.api.listThreadDirectory({ threadId: q(), includeIgnored: true }),
      (value) => value.entries.some((entry) => entry.name === "renamed.txt" && entry.gitStatus === "R"),
    );

    expect(page.gitStatusComplete).toBe(true);
    expect(page.entries.find((entry) => entry.name === "README.md")?.gitStatus).toBe("M");
    expect(page.entries.find((entry) => entry.name === "removed.txt")).toMatchObject({
      kind: Kind.DELETED,
      gitStatus: "D",
    });
    expect(page.entries.find((entry) => entry.name === "ignored")?.gitStatus).toBe("!");
    expect(
      (await caller.api.listThreadDirectory({ threadId: q() })).entries.some((entry) => entry.name === "ignored"),
    ).toBe(false);
  });

  test("the ninth retained iterator is refused, and release makes room", async () => {
    const tokens: string[] = [];

    try {
      for (let index = 0; index < 8; index++) {
        const page = await home.gw.api.listThreadDirectory({ threadId: thread.id, directory: "many", pageSize: 1 });
        tokens.push(page.nextPageToken);
      }

      expect(
        await failure(home.gw.api.listThreadDirectory({ threadId: thread.id, directory: "many", pageSize: 1 })),
      ).toContain("Too many directories");
      await home.gw.api.listThreadDirectory({
        threadId: thread.id,
        directory: "many",
        pageToken: tokens.pop()!,
        release: true,
      });

      const replacement = await home.gw.api.listThreadDirectory({
        threadId: thread.id,
        directory: "many",
        pageSize: 1,
      });

      tokens.push(replacement.nextPageToken);
      expect(replacement.entries).toHaveLength(1);
    } finally {
      await Promise.all(
        tokens.map((pageToken) =>
          home.gw.api.listThreadDirectory({ threadId: thread.id, directory: "many", pageToken, release: true }),
        ),
      );
    }
  });

  test("an older worker is rejected before dispatch, and a restarted worker cannot resume an old cursor", async () => {
    const worker = home.gw.core.link.connections.get(home.workerId)!;
    const capabilities = worker.hello.capabilities;
    worker.hello.capabilities = capabilities.filter((value) => value !== "thread_directory_v1");

    try {
      expect(await failure(caller.api.listThreadDirectory({ threadId: q() }))).toContain("Update Canopy");
    } finally {
      worker.hello.capabilities = capabilities;
    }

    const first = await caller.api.listThreadDirectory({ threadId: q(), directory: "many", pageSize: 1 });
    await home.restart();

    const resumed = await caller.api.listThreadDirectory({
      threadId: q(),
      directory: "many",
      pageToken: first.nextPageToken,
    });

    expect(resumed.error).toBe(Failure.CURSOR_EXPIRED);
    expect(resumed.entries).toEqual([]);
    const fresh = await caller.api.listThreadDirectory({ threadId: q(), directory: "folder" });
    expect(fresh.entries[0]?.name).toBe("nested.txt");
  });
});
