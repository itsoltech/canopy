import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { imageScopeKey, ImmutableImageCache } from "../../apps/mobile/src/storage/image-cache.ts";
import { imageCacheKey } from "../../apps/mobile/src/features/attachments/image-source.ts";
import { clearPairedHistory } from "../../apps/mobile/src/storage/bot-cache.ts";
import { PersistentArchivedCache } from "../../apps/mobile/src/storage/archived-cache.ts";
import { DiskImageStorage, imageHash } from "./support/image-cache.ts";
import { DiskThreadStorage } from "./support/thread-cache.ts";

const directory = tempDirs();
const signal = () => new AbortController().signal;

const file = (id: string) => ({
  kind: "attachment" as const,
  file: create(ui.AttachmentSchema, { id, hasThumbnail: true }),
});

const limits = { memory: 4, disk: 8, count: 2 };

test("immutable images survive remount/restart, keep variants and qualified computers apart, and obey both budgets", async () => {
  const storage = new DiskImageStorage(directory("canopy-images-lru-"));
  let cache = new ImmutableImageCache(storage, imageHash, limits);
  let requests = 0;

  const read = async () => {
    requests++;

    return new Uint8Array([1, 2, 3, 4]);
  };

  const key = imageCacheKey(file("computer-a~attachment"), true);
  const uri = await cache.get(key, read, signal());
  expect(uri.startsWith("file://")).toBe(true);
  expect(await cache.get(key, read, signal())).toBe(uri);
  cache = new ImmutableImageCache(storage, imageHash, limits);
  expect(await cache.get(key, read, signal())).toBe(uri);
  expect(requests).toBe(1);
  const full = imageCacheKey(file("computer-a~attachment"), false);
  const other = imageCacheKey(file("computer-b~attachment"), true);
  expect(full).not.toBe(key);
  expect(other).not.toBe(key);
  await cache.get(full, read, signal());
  await cache.get(key, read, signal()); // thumbnail is newer than full
  await cache.get(other, read, signal());
  expect((await storage.list()).map((image) => image.key)).not.toContain(await imageHash(full));
  expect(cache.usage().memoryBytes).toBeLessThanOrEqual(4);
  expect((await storage.list()).reduce((bytes, image) => bytes + image.bytes, 0)).toBeLessThanOrEqual(8);
  expect((await storage.list()).every((image) => /^[a-f0-9]{64}$/.test(image.key))).toBe(true);
  // OS cache purging invalidates even a warm URI; it is downloaded again instead of returning a broken path.
  const otherHash = await imageHash(other);
  const current = (await storage.list()).find((image) => image.key === otherHash)!;
  await storage.remove(current);
  await cache.get(other, read, signal());
  expect(requests).toBe(4);
  expect(await storage.read(uri)).toHaveLength(4);
  await cache.invalidate(key);
  await cache.get(key, read, signal());
  expect(requests).toBe(5);
});

test("full-only blobs and attachments reuse the list download in the viewer", async () => {
  const cache = new ImmutableImageCache(new DiskImageStorage(directory("canopy-images-full-")), imageHash);
  const blob = { kind: "thread" as const, threadId: "computer-a~thread", sha256: "digest", sizeBytes: 4n };
  const attachment = { kind: "attachment" as const, file: create(ui.AttachmentSchema, { id: "computer-a~file" }) };
  let requests = 0;

  const read = async () => {
    requests++;

    return new Uint8Array([1, 2, 3, 4]);
  };

  for (const source of [blob, attachment]) {
    const preview = await cache.get(imageCacheKey(source, true), read, signal());
    expect(await cache.get(imageCacheKey(source, false), read, signal())).toBe(preview);
  }

  expect(requests).toBe(2);
  expect(imageCacheKey(blob, true)).not.toBe(imageCacheKey({ ...blob, threadId: "computer-b~thread" }, true));
});

test("shared requests cancel only when their last view leaves; failure remains retryable", async () => {
  const storage = new DiskImageStorage(directory("canopy-images-cancel-"));
  const cache = new ImmutableImageCache(storage, imageHash);
  const entered = Promise.withResolvers<void>();
  const bytes = Promise.withResolvers<Uint8Array>();
  let requestSignal: AbortSignal | undefined;
  let requests = 0;

  const read = (signal: AbortSignal) => {
    requests++;
    requestSignal = signal;
    entered.resolve();

    return bytes.promise;
  };

  const first = new AbortController();
  const second = new AbortController();
  const a = cache.get("same", read, first.signal);
  const b = cache.get("same", read, second.signal);
  const cancelled = a.catch((error: Error) => error);
  await entered.promise;
  first.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(requestSignal?.aborted).toBe(false);
  bytes.resolve(new Uint8Array([1]));
  expect(await b).toStartWith("file://");
  expect(requests).toBe(1);

  const last = new AbortController();
  const started = Promise.withResolvers<void>();

  const pending = cache.get(
    "cancel",
    (signal) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        started.resolve();
      }),
    last.signal,
  );

  const rejection = pending.catch((error: Error) => error);
  await started.promise;
  last.abort();
  expect(await rejection).toMatchObject({ name: "AbortError" });
  expect(await cache.get("cancel", async () => new Uint8Array([2]), signal())).toStartWith("file://");
});

test("owner-bound pairing scopes cannot collide, and unpair/revoke fences late downloads before wiping files", async () => {
  const root = directory("canopy-images-pairing-");
  const a = await imageHash(imageScopeKey({ deviceId: "owner-a", fingerprint: "gateway-a" }));
  const b = await imageHash(imageScopeKey({ deviceId: "owner-b", fingerprint: "gateway-a" }));
  const c = await imageHash(imageScopeKey({ deviceId: "owner-a", fingerprint: "gateway-b" }));
  expect(new Set([a, b, c]).size).toBe(3);
  const storage = new DiskImageStorage(join(root, a));
  const nextStorage = new DiskImageStorage(join(root, b));
  const cache = new ImmutableImageCache(storage, imageHash);
  const next = new ImmutableImageCache(nextStorage, imageHash);
  const archiveStorage = new DiskThreadStorage(join(root, "archives", a));
  const archive = new PersistentArchivedCache(archiveStorage);
  const filter = { projectIds: [], query: "" };
  await archive.reconcile(create(ui.ThreadSchema, { id: "saved", status: "archived" }));
  expect(archive.peek(filter)?.threads).toHaveLength(1);
  const oldUri = await cache.get("image", async () => new Uint8Array([1]), signal());
  const newUri = await next.get("image", async () => new Uint8Array([2]), signal());
  expect(newUri).not.toBe(oldUri);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Uint8Array>();

  const late = cache.get(
    "late",
    () => {
      entered.resolve();

      return release.promise;
    },
    signal(),
  );

  const rejected = late.catch((error: Error) => error);
  await entered.promise;
  let forgotten = false;
  expect(
    await clearPairedHistory([cache, archive], async () => {
      forgotten = true;
    }),
  ).toBe(true);
  release.resolve(new Uint8Array([3]));
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(forgotten).toBe(true);
  expect(cache.usage().memoryEntries).toBe(0);
  expect(archive.peek(filter)).toBeUndefined();
  await archive.reconcile(create(ui.ThreadSchema, { id: "late", status: "archived" }));
  expect(await archiveStorage.list()).toEqual([]);
  expect(await storage.list()).toEqual([]);
  expect([...(await nextStorage.read(newUri))]).toEqual([2]);
  await expect(cache.get("image", async () => new Uint8Array([4]), signal())).rejects.toMatchObject({
    name: "AbortError",
  });
});
