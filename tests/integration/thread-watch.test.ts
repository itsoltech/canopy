import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CommandSchema,
  ThreadFilesUpdateSchema,
  ThreadFileChangeKind as Kind,
  ui,
  type ThreadFilesUpdate,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { qualifyId } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { WorkspaceStore } from "@canopy/domain/workspace";
import { WorkspaceFileConflict, WorkspaceAccessRevoked } from "@canopy/domain/workspace-file";
import { workspaceDirectories } from "@canopy/domain/workspace-directory";
import { observeWorkspaceFile } from "@canopy/domain/workspace-changes";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("scoped file invalidations over the real worker and linked home", () => {
  const dir = tempDir("canopy-thread-watch-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  const q = (id = thread.id) => qualifyId(id, b.hello().nodeId);
  const worker = () => home.gw.core.link.connections.get(home.workerId)!;

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, {
      role: "desktop",
      capabilities: ["thread_files_watch_v1", "thread_files_v1", "thread_file_preview_v1", "thread_directory_v1"],
    });
    thread = await home.tree();
    mkdirSync(join(thread.cwd, "folder"));
    writeFileSync(join(thread.cwd, "folder", "source.txt"), "base");
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

  async function start(request: MessageInitShape<typeof ui.WatchThreadFilesRequestSchema>, remote = true) {
    const abort = new AbortController();
    const updates: ThreadFilesUpdate[] = [];

    const done = (async () => {
      for await (const update of (remote ? caller.api : home.gw.api).watchThreadFiles(request, {
        signal: abort.signal,
        timeoutMs: 0,
      }))
        updates.push(update);
    })().catch((cause: unknown) => {
      if (!abort.signal.aborted) throw cause;
    });

    await eventually(() => Promise.resolve(updates.length), Boolean);

    return {
      updates,
      done,
      close: async () => {
        abort.abort();
        await done;
      },
    };
  }

  async function rejected(request: MessageInitShape<typeof ui.WatchThreadFilesRequestSchema>) {
    try {
      for await (const _ of caller.api.watchThreadFiles(request, { timeoutMs: 5000 })) break;

      return 0;
    } catch (cause) {
      return ConnectError.from(cause).code;
    }
  }

  test("only visible paths are invalidated; envelopes contain no source or directory snapshots", async () => {
    for (const remote of [false, true]) {
      const stream = await start(
        { threadId: remote ? q() : thread.id, directories: ["folder"], files: ["folder/source.txt"] },
        remote,
      );

      try {
        expect(stream.updates[0]?.revalidateRequired).toBe(true);
        const secret = "bytes-never-in-an-invalidation";
        writeFileSync(join(thread.cwd, "folder", "source.txt"), secret);
        writeFileSync(join(thread.cwd, "unobserved.txt"), secret);
        await eventually(
          () =>
            Promise.resolve(
              stream.updates.some((update) =>
                update.changes.some(
                  (change) => change.kind === Kind.FILE_CHANGED && change.path === "folder/source.txt",
                ),
              ),
            ),
          Boolean,
        );

        for (const update of stream.updates) {
          expect(toBinary(ThreadFilesUpdateSchema, update).byteLength).toBeLessThanOrEqual(64 * 1024);
          expect(update.changes.length).toBeLessThanOrEqual(64);
          expect(toJsonString(ThreadFilesUpdateSchema, update)).not.toContain(secret);
          expect(update.changes.every((change) => ["folder", "folder/source.txt"].includes(change.path))).toBe(true);
        }

        unlinkSync(join(thread.cwd, "folder", "source.txt"));
        await eventually(
          () =>
            Promise.resolve(
              stream.updates.some((update) => update.changes.some((change) => change.kind === Kind.FILE_REMOVED)),
            ),
          Boolean,
        );
      } finally {
        await stream.close();
        writeFileSync(join(thread.cwd, "folder", "source.txt"), "base");
      }

      await eventually(
        () => Promise.resolve(worker().fileWatches.size),
        (size) => size === 0,
      );
    }
  });

  test("a live checkpoint replays invalidations, and the last cancellation destroys the checkout epoch", async () => {
    const first = await start({ threadId: q(), directories: ["folder"], files: ["folder/source.txt"] });
    const checkpoint = first.updates[0]!;

    try {
      writeFileSync(join(thread.cwd, "folder", "source.txt"), "replay");
      await eventually(
        () => Promise.resolve(first.updates.length),
        (count) => count > 1,
      );

      const second = await start({
        threadId: q(),
        files: ["folder/source.txt"],
        rootIdentity: checkpoint.rootIdentity,
        cursor: checkpoint.cursor,
      });

      try {
        expect(second.updates[0]?.revalidateRequired).toBe(false);
        expect(second.updates[0]?.changes).toContainEqual(
          expect.objectContaining({ kind: Kind.FILE_CHANGED, path: "folder/source.txt" }),
        );
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }

    await eventually(
      () => Promise.resolve(worker().fileWatches.size),
      (size) => size === 0,
    );

    const fresh = await start({
      threadId: q(),
      directories: ["folder"],
      rootIdentity: checkpoint.rootIdentity,
      cursor: checkpoint.cursor,
    });

    try {
      expect(fresh.updates[0]?.revalidateRequired).toBe(true);
      expect(fresh.updates[0]?.cursor.split(":")[0]).not.toBe(checkpoint.cursor.split(":")[0]);
    } finally {
      await fresh.close();
    }
  });

  test("path escapes, symlinks and excessive scope fail before receiving names", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(thread.cwd, "escape"));

    for (const path of ["..", "folder/../../outside", "..\\outside", outside, "C:/outside", ".git", "escape"])
      expect(await rejected({ threadId: q(), directories: [path] })).not.toBe(0);
    expect(await rejected({ threadId: q(), directories: Array.from({ length: 33 }, () => "folder") })).toBe(
      Code.InvalidArgument,
    );

    const raw = await home.host.handleCommand(
      create(CommandSchema, {
        commandId: crypto.randomUUID(),
        kind: {
          case: "watchThreadFiles",
          value: {
            subscriptionId: crypto.randomUUID(),
            ownerId: home.gw.userId,
            threadId: thread.id,
            workspace: thread.cwd,
            directories: ["escape"],
          },
        },
      }),
    );

    expect(raw?.ok).toBe(false);
  });

  test("another owner and an older worker are refused at the home", async () => {
    const owner = await home.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("watch-owner@example.test", "Other owner")),
    );

    const id = crypto.randomUUID();
    await home.sql(
      (sql) => sql`
      INSERT INTO threads (id,project_id,owner_user_id,kind,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,title,status)
      SELECT ${id}::uuid,project_id,${owner}::uuid,'main',${id}::uuid,0,runtime,provider,worker_id,workspace_id,cwd,'Private files','idle'
      FROM threads WHERE id=${thread.id}::uuid
    `,
    );
    expect(await rejected({ threadId: q(id), directories: [""] })).not.toBe(0);
    const capabilities = worker().hello.capabilities;
    worker().hello.capabilities = capabilities.filter((value) => value !== "thread_files_watch_v1");

    try {
      expect(await rejected({ threadId: q(), directories: [""] })).toBe(Code.Unimplemented);
    } finally {
      worker().hello.capabilities = capabilities;
    }
  });

  test("bursts and a stale replay stay bounded and ask only for visible-scope revalidation", async () => {
    const stream = await start({ threadId: q(), directories: ["folder"] });

    try {
      for (let index = 0; index < 400; index++) writeFileSync(join(thread.cwd, "folder", `burst-${index}`), "");
      await eventually(
        () => Promise.resolve(stream.updates.some((update, index) => index > 0 && update.revalidateRequired)),
        Boolean,
      );

      const resumed = await start({
        threadId: q(),
        directories: ["folder"],
        rootIdentity: stream.updates[0]!.rootIdentity,
        cursor: "stale:0",
      });

      try {
        expect(resumed.updates[0]?.revalidateRequired).toBe(true);
        expect(resumed.updates[0]?.changes).toEqual([]);
      } finally {
        await resumed.close();
      }

      expect(stream.updates.every((update) => update.changes.length <= 64)).toBe(true);
    } finally {
      await stream.close();
    }
  });

  test("dirty revalidation and typed hash conflicts preserve the draft without replaying a write", async () => {
    const store = new WorkspaceStore(
      {
        watchFiles: async (request, signal, receive) => {
          for await (const update of caller.api.watchThreadFiles(request, { signal, timeoutMs: 0 })) receive(update);
        },
        read: (target, path, hash, signal) =>
          caller.api.readThreadFile({ threadId: target.threadId, path, expectedSha256: hash }, { signal }),
        write: async (target, path, text, hash) => {
          try {
            return await caller.api.writeThreadFile({
              threadId: target.threadId,
              path,
              content: new TextEncoder().encode(text),
              expectedSha256: hash,
            });
          } catch (cause) {
            const error = ConnectError.from(cause);

            if (error.code === Code.Aborted) throw new WorkspaceFileConflict(error.rawMessage);
            throw cause;
          }
        },
        remove: async () => {},
      },
      8 * 1024 * 1024,
    );

    const view = store.view(q());
    view.open({ threadId: q(), path: "folder/source.txt" });
    const document = view.currentFile!.document;
    await document.load();
    document.edit();
    document.setDraft("my unsaved changes");
    const stop = observeWorkspaceFile(store, document);

    try {
      await eventually(() => Promise.resolve(worker().fileWatches.size), Boolean);
      writeFileSync(join(thread.cwd, "folder", "source.txt"), "other process");
      await eventually(() => Promise.resolve(document.changedOnDisk), Boolean);
      expect(document.draft).toBe("my unsaved changes");
      expect(document.diskText).toBe("other process");
      expect(await document.save()).toBe(false);
      document.discard();
      await document.load();
      document.edit();
      document.setDraft("another draft");
      stop();
      await eventually(
        () => Promise.resolve(worker().fileWatches.size),
        (count) => count === 0,
      );
      writeFileSync(join(thread.cwd, "folder", "source.txt"), "conflict without watch");
      expect(await document.save()).toBe(false);
      expect(document.changedOnDisk).toBe(true);
      expect(document.draft).toBe("another draft");
      const onDisk = await caller.api.readThreadFile({ threadId: q(), path: "folder/source.txt" });
      expect(new TextDecoder().decode(onDisk.content)).toBe("conflict without watch");
    } finally {
      stop();
      store.clear();
    }
  });

  function resourceStore() {
    return new WorkspaceStore(
      {
        listDirectory: (request, signal) => caller.api.listThreadDirectory(request, { signal }),
        read: (target, path, hash, signal) =>
          caller.api.readThreadFile({ threadId: target.threadId, path, expectedSha256: hash }, { signal }),
        write: (target, path, text, hash) =>
          caller.api.writeThreadFile({
            threadId: target.threadId,
            path,
            content: new TextEncoder().encode(text),
            expectedSha256: hash,
          }),
        remove: async () => {},
        watchFiles: async (request, signal, receive) => {
          try {
            for await (const update of caller.api.watchThreadFiles(request, { signal, timeoutMs: 0 })) receive(update);
          } catch (cause) {
            if ([Code.PermissionDenied, Code.NotFound].includes(ConnectError.from(cause).code))
              throw new WorkspaceAccessRevoked("File access ended.");
            throw cause;
          }
        },
      },
      8 * 1024 * 1024,
    );
  }

  test("clearing a paired scope releases real streams and cursors and erases retained dirty documents", async () => {
    const store = resourceStore();
    const view = store.view(q());
    view.open({ threadId: q(), path: "folder/source.txt" });
    const document = view.currentFile!.document;
    await document.load();
    document.edit();
    document.setDraft("private unsaved text");
    const tree = workspaceDirectories(store, 1024 * 1024).tree(q());
    const releaseTree = tree.retain();
    const releaseFile = observeWorkspaceFile(store, document);

    try {
      await eventually(() => Promise.resolve(worker().fileWatches.size), Boolean);
      store.clear();
      // Late UI cleanup must not resurrect a subscription after unpairing.
      releaseFile();
      releaseTree();
      releaseTree();
      expect(document.draft).toBe("");
      expect(document.text).toBe("");
      expect(document.file).toBeUndefined();
      expect(tree.nodes.size).toBe(0);
      await eventually(
        () => Promise.resolve(worker().fileWatches.size),
        (size) => size === 0,
      );
      await document.load();
      expect(document.file).toBeUndefined();
    } finally {
      releaseFile();
      releaseTree();
      store.clear();
    }
  });

  test("thread access revocation stops retries and removes cached bytes before another update is delivered", async () => {
    const isolated = await home.tree();
    mkdirSync(join(isolated.cwd, "folder"));
    writeFileSync(join(isolated.cwd, "folder", "source.txt"), "private base");
    const id = q(isolated.id);
    const store = resourceStore();
    const view = store.view(id);
    view.open({ threadId: id, path: "folder/source.txt" });
    const document = view.currentFile!.document;
    await document.load();
    document.edit();
    document.setDraft("private draft");
    const release = observeWorkspaceFile(store, document);

    try {
      await eventually(() => Promise.resolve(worker().fileWatches.size), Boolean);
      await home.sql((sql) => sql`UPDATE threads SET deleted_at=now() WHERE id=${isolated.id}::uuid`);
      writeFileSync(join(isolated.cwd, "folder", "source.txt"), "inaccessible bytes");
      await eventually(
        () => Promise.resolve(view.tabs.length),
        (size) => size === 0,
      );
      expect(document.text).toBe("");
      expect(document.draft).toBe("");
      expect(document.file).toBeUndefined();
      await eventually(
        () => Promise.resolve(worker().fileWatches.size),
        (size) => size === 0,
      );
    } finally {
      release();
      store.clear();
    }
  });

  test("a replaced worktree root preserves the old draft and requires explicit reload", async () => {
    const store = resourceStore();
    const view = store.view(q());
    view.open({ threadId: q(), path: "folder/source.txt" });
    const document = view.currentFile!.document;
    await document.load();
    document.edit();
    document.setDraft("draft from old worktree");
    const release = observeWorkspaceFile(store, document);
    const backup = `${thread.cwd}-moved`;
    let moved = false;

    try {
      await eventually(() => Promise.resolve(worker().fileWatches.size), Boolean);
      renameSync(thread.cwd, backup);
      moved = true;
      mkdirSync(thread.cwd);
      mkdirSync(join(thread.cwd, "folder"));
      writeFileSync(join(thread.cwd, "folder", "source.txt"), "replacement root");
      await eventually(
        () => Promise.resolve(document.error),
        (error) => error.includes("working directory changed"),
      );
      expect(document.draft).toBe("draft from old worktree");
      expect(await document.save()).toBe(false);
      await document.revalidate();
      expect(document.text).not.toBe("replacement root");
      document.discard();
      await document.load();
      expect(document.text).toBe("replacement root");
    } finally {
      release();
      store.clear();

      if (moved) {
        rmSync(thread.cwd, { recursive: true });
        renameSync(backup, thread.cwd);
      }
    }
  });
});
