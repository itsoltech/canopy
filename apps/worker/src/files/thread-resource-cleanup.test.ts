import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ListThreadDirectorySchema,
  ThreadDirectoryError,
  ThreadFilesWatchSchema,
  type ThreadFilesUpdate,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { VerifiedDirectory } from "./directory-handle.ts";
import { ThreadDirectories } from "./thread-directory.ts";
import { ThreadFilesWatcher } from "./thread-watch.ts";
import { CheckoutFiles } from "./checkout-files.ts";

const temp = tempDirs();

test("closing a thread drains a native directory open and preserves another thread's cursor", async () => {
  const workspace = temp("canopy-thread-directory-close-");

  for (let index = 0; index < 4; index++) writeFileSync(join(workspace, `${index}.txt`), "content");

  const directories = new ThreadDirectories();

  const request = (threadId: string, pageToken = "") =>
    create(ListThreadDirectorySchema, { workspace, threadId, pageSize: 1, pageToken });

  const survivor = await directories.list(request("survivor"));
  const archived = await directories.list(request("archived"));
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const open = VerifiedDirectory.open.bind(VerifiedDirectory);
  let closed = false;

  const probe = spyOn(VerifiedDirectory, "open").mockImplementation(async (target) => {
    const handle = await open(target);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closed = true;
      await close();
    };

    entered.resolve();
    await resume.promise;

    return handle;
  });

  const listing = directories.list(request("archived"));

  try {
    await entered.promise;
    const closing = directories.closeThread("archived");
    resume.resolve();
    await closing;
    const cancelled = await listing;
    expect(closed).toBe(true);
    expect(cancelled.entries).toEqual([]);
    expect(cancelled.nextPageToken).toBe("");
    expect((await directories.list(request("archived", archived.nextPageToken))).error).toBe(
      ThreadDirectoryError.CURSOR_EXPIRED,
    );
    expect((await directories.list(request("survivor", survivor.nextPageToken))).entries).toHaveLength(1);
  } finally {
    resume.resolve();
    await listing;
    probe.mockRestore();
    await directories.close();
  }
});

test("closing during path resolution does not open a directory or retain its capacity", async () => {
  const workspace = temp("canopy-thread-directory-fence-");
  writeFileSync(join(workspace, "file.txt"), "content");
  const directories = new ThreadDirectories();
  const probe = spyOn(VerifiedDirectory, "open");

  try {
    for (let index = 0; index < 10; index++) {
      const threadId = `archived-${index}`;
      const listing = directories.list(create(ListThreadDirectorySchema, { threadId, workspace }));
      await directories.closeThread(threadId);
      expect((await listing).entries).toEqual([]);
    }

    expect(probe).not.toHaveBeenCalled();
    expect(
      (await directories.list(create(ListThreadDirectorySchema, { threadId: "survivor", workspace }))).complete,
    ).toBe(true);
  } finally {
    probe.mockRestore();
    await directories.close();
  }
});

test("closing Files during queued reconciliation preserves shared native watches", async () => {
  const workspace = temp("canopy-thread-watch-close-");
  mkdirSync(join(workspace, "slow"));
  const watcher = new ThreadFilesWatcher();
  const updates: ThreadFilesUpdate[] = [];

  const request = (threadId: string) =>
    create(ThreadFilesWatchSchema, {
      ownerId: "owner",
      threadId,
      workspace,
      subscriptionId: threadId,
      directories: ["slow"],
    });

  const add = CheckoutFiles.prototype.add;
  const entered = Promise.withResolvers<CheckoutFiles>();
  const resume = Promise.withResolvers<void>();

  const probe = spyOn(CheckoutFiles.prototype, "add").mockImplementation(async function (
    this: CheckoutFiles,
    ...args: Parameters<typeof add>
  ) {
    if (args[0].threadId === "archived") {
      entered.resolve(this);
      await resume.promise;
    }

    return add.apply(this, args);
  });

  const pending = watcher.watch(request("archived"), (update) => updates.push(update));

  try {
    const checkout = await entered.promise;
    await watcher.watch(request("survivor"), (update) => updates.push(update));
    const closing = watcher.closeThread("archived");
    resume.resolve();
    await closing;
    await pending;
    expect(checkout.subscribers.size).toBe(1);
    expect(checkout.subscribers.has("survivor")).toBe(true);
    expect(checkout.watchers.size).toBeGreaterThan(0);
    expect(updates.map((update) => update.subscriptionId)).toEqual(["survivor"]);
    await watcher.closeThread("survivor");
    expect(checkout.watchers.size).toBe(0);
  } finally {
    resume.resolve();
    await pending;
    watcher.close();
    probe.mockRestore();
  }
});

test("closing Files also drains additions already released before archive", async () => {
  const workspace = temp("canopy-thread-watch-released-close-");
  const watcher = new ThreadFilesWatcher();
  const request = create(ThreadFilesWatchSchema, { threadId: "archived", workspace, subscriptionId: "subscription" });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const add = CheckoutFiles.prototype.add;

  const probe = spyOn(CheckoutFiles.prototype, "add").mockImplementation(async function (
    this: CheckoutFiles,
    ...args: Parameters<typeof add>
  ) {
    entered.resolve();
    await resume.promise;

    return add.apply(this, args);
  });

  const pending = watcher.watch(request, () => {});

  try {
    await entered.promise;
    await watcher.watch({ ...request, release: true }, () => {});
    let finished = false;

    const closing = watcher.closeThread("archived").then(() => {
      finished = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);
    resume.resolve();
    await closing;
    await pending;
    expect(finished).toBe(true);
  } finally {
    resume.resolve();
    await pending;
    watcher.close();
    probe.mockRestore();
  }
});
