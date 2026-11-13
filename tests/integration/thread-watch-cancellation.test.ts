import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ThreadFilesWatchSchema, type ThreadFilesUpdate } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { CheckoutFiles } from "../../apps/worker/src/files/checkout-files.ts";
import { ThreadFilesWatcher } from "../../apps/worker/src/files/thread-watch.ts";
import * as workerGit from "../../apps/worker/src/git/git.ts";
import { eventually } from "./support/gateway.ts";

test("released queued additions and cancellation during reconciliation cannot resurrect watches", async () => {
  const workspace = tempDir("canopy-watch-cancellation-");
  mkdirSync(join(workspace, "slow"));
  const watcher = new ThreadFilesWatcher();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const git = workerGit.git;

  const probe = spyOn(workerGit, "git").mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;

    return git(...args);
  });

  const add = CheckoutFiles.prototype.add;
  const coordinators = new Set<CheckoutFiles>();
  let queued = 0;

  const additions = spyOn(CheckoutFiles.prototype, "add").mockImplementation(function (
    this: CheckoutFiles,
    ...args: Parameters<typeof add>
  ) {
    coordinators.add(this);
    queued++;

    return add.apply(this, args);
  });

  const updates: ThreadFilesUpdate[] = [];

  const request = (id: string, release = false) =>
    create(ThreadFilesWatchSchema, {
      ownerId: "owner",
      threadId: "thread",
      workspace,
      subscriptionId: id,
      directories: ["slow"],
      release,
    });

  const running = [watcher.watch(request("reconciling"), (update) => updates.push(update))];

  try {
    await entered.promise;

    for (let index = 0; index < 35; index++) {
      const id = `released-${index}`;
      running.push(watcher.watch(request(id), (update) => updates.push(update)));
      await eventually(
        () => Promise.resolve(queued),
        (count) => count === index + 2,
      );
      await watcher.watch(request(id, true), () => {});
    }

    await watcher.watch(request("reconciling", true), () => {});
    resume.resolve();
    await Promise.all(running);
    expect(coordinators.size).toBe(1);

    for (const checkout of coordinators) {
      expect(checkout.subscribers.size).toBe(0);
      expect(checkout.watchers.size).toBe(0);
      expect(checkout.idle).toBe(true);
    }

    writeFileSync(join(workspace, "slow", "after-release.txt"), "no callbacks");
    await Bun.sleep(250);
    expect(updates).toEqual([]);
    const fresh: ThreadFilesUpdate[] = [];
    await watcher.watch(request("fresh"), (update) => fresh.push(update));
    expect(fresh).toHaveLength(1);
    await watcher.watch(request("fresh", true), () => {});

    for (const checkout of coordinators) {
      expect(checkout.subscribers.size).toBe(0);
      expect(checkout.watchers.size).toBe(0);
    }
  } finally {
    resume.resolve();
    await Promise.allSettled(running);
    watcher.close();
    probe.mockRestore();
    additions.mockRestore();
  }
});
