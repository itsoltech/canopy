import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ui, type Item } from "@canopy/contracts";
import { ItemContentCache, itemContents } from "../src/lib/features/threads/item-content-cache.ts";
import { threadCache } from "../src/lib/features/threads/thread-cache.ts";

const reference = (sha256: string, bytes: number) =>
  create(ui.ThreadSyncContentSchema, { sha256, sizeBytes: BigInt(bytes) });

const signal = () => new AbortController().signal;
const item = (text: string) => create(ItemSchema, { content: { case: "agentMessage", value: { text } } });

test("mounted output and answer actions keep large items until both release, then the next expansion reloads", async () => {
  const cache = new ItemContentCache({ count: 2, bytes: 10 });
  const large = reference("large", 11);
  const small = reference("small", 4);
  const medium = reference("medium", 7);
  const result = item("full output");
  const load = (ref: ui.ThreadSyncContent) => cache.load("thread", ref, signal(), async () => result);
  const row = cache.watch("thread", large, () => {});
  const actions = cache.watch("thread", large, () => {});
  await load(large);
  await load(small);
  await load(medium);
  expect(cache.get("thread", small)).toBeUndefined();
  expect(cache.get("thread", medium)).toBe(result);
  row();
  expect(cache.get("thread", large)).toBe(result);
  actions();
  expect(cache.get("thread", large)).toBeUndefined();
  expect(cache.get("thread", medium)).toBe(result);
  const reopened = cache.watch("thread", large, () => {});
  await load(large);
  expect(cache.get("thread", large)).toBe(result);
  reopened();

  const tiny = [reference("a", 1), reference("b", 1), reference("c", 1)];

  for (const ref of tiny.slice(0, 2)) await load(ref);
  const revisit = cache.watch("thread", tiny[0]!, () => {});
  revisit();
  await load(tiny[2]!);
  expect(tiny.map((ref) => cache.get("thread", ref))).toEqual([result, undefined, result]);
});

test("a released scope aborts reads and a late completion cannot overwrite the new read of the same hash", async () => {
  const ref = reference("same-content-hash", 8);
  const old = item("old response");
  const current = item("new response");
  const elsewhere = item("qualified for another thread");
  const mounted = itemContents.watch("one", ref, () => {});
  const delayed = Promise.withResolvers<Item>();
  const other = Promise.withResolvers<Item>();
  const closing = Promise.withResolvers<Item>();
  let firstSignal: AbortSignal | undefined;

  const pending = itemContents.load("one", ref, signal(), (s) => {
    firstSignal = s;

    return delayed.promise;
  });

  const otherRead = itemContents.load("two", ref, signal(), () => other.promise);
  itemContents.release("one");
  expect(firstSignal?.aborted).toBe(true);
  await itemContents.load("one", ref, signal(), async () => current);
  delayed.resolve(old);
  other.resolve(elsewhere);
  await expect(pending).rejects.toThrow();
  await otherRead;
  expect(itemContents.get("one", ref)).toBe(current);
  expect(itemContents.get("two", ref)).toBe(elsewhere);
  const staleSession = itemContents.load("two", ref, signal(), () => closing.promise);
  threadCache.clear();
  closing.resolve(old);
  await expect(staleSession).rejects.toThrow();
  expect(itemContents.get("one", ref)).toBeUndefined();
  expect(itemContents.get("two", ref)).toBeUndefined();
  mounted();
});
