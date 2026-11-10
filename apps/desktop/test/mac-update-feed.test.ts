import { expect, test } from "bun:test";
import { MacUpdateFeed } from "../src/mac-update-feed.ts";

test("an unchanged native feed installs synchronously without staging the ZIP again", async () => {
  let nativeFeed = "";
  const events: string[] = [];

  const feed = new MacUpdateFeed(async () => {
    nativeFeed = "ready.zip";
    events.push("stage");
  });

  await feed.commit();
  feed.install(
    () => events.push(`install:${nativeFeed}`),
    (cause) => {
      throw cause;
    },
  );

  expect(events).toEqual(["stage", "install:ready.zip"]);
});

test("a newer updater's commit replays the selected ZIP before installation", async () => {
  let nativeFeed = "";
  const events: string[] = [];

  const ready = new MacUpdateFeed(async () => {
    nativeFeed = "ready.zip";
    events.push("stage:ready");
  });

  const replacement = new MacUpdateFeed(async () => {
    nativeFeed = "replacement.zip";
    events.push("stage:replacement");
  });

  await ready.commit();
  await replacement.commit();
  const installed = Promise.withResolvers<void>();
  ready.install(() => {
    events.push(`install:${nativeFeed}`);
    installed.resolve();
  }, installed.reject);

  expect(events).toEqual(["stage:ready", "stage:replacement"]);
  await installed.promise;
  expect(events).toEqual(["stage:ready", "stage:replacement", "stage:ready", "install:ready.zip"]);
});

test("replay waits for a pending replacement finalizer and restores the selected ZIP last", async () => {
  let nativeFeed = "";

  const ready = new MacUpdateFeed(async () => {
    nativeFeed = "ready.zip";
  });

  const finish = Promise.withResolvers<void>();

  const replacement = new MacUpdateFeed(async () => {
    await finish.promise;
    nativeFeed = "replacement.zip";
  });

  await ready.commit();
  const pending = replacement.commit();
  const installed = Promise.withResolvers<string>();
  let installing = false;
  ready.install(() => {
    installing = true;
    installed.resolve(nativeFeed);
  }, installed.reject);

  await Promise.resolve();
  expect(installing).toBe(false);
  finish.resolve();
  await pending;
  expect(await installed.promise).toBe("ready.zip");
});

test("a replay failure reaches installation error handling without installing the wrong ZIP", async () => {
  const failure = new Error("Could not read the staged ZIP");
  let readable = true;
  let nativeFeed = "";

  const ready = new MacUpdateFeed(async () => {
    if (!readable) throw failure;
    nativeFeed = "ready.zip";
  });

  await ready.commit();
  await new MacUpdateFeed(async () => {
    nativeFeed = "replacement.zip";
  }).commit();
  readable = false;
  let installing = false;
  const failed = Promise.withResolvers<unknown>();
  ready.install(() => {
    installing = true;
  }, failed.resolve);

  expect(await failed.promise).toBe(failure);
  expect(installing).toBe(false);
  expect(nativeFeed).toBe("replacement.zip");

  readable = true;
  const retried = Promise.withResolvers<string>();
  ready.install(() => retried.resolve(nativeFeed), retried.reject);

  expect(await retried.promise).toBe("ready.zip");
});
