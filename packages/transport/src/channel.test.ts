import { describe, expect, test } from "bun:test";
import { AsyncChannel } from "./channel.ts";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("AsyncChannel", () => {
  test("delivers values pushed before and after the consumer starts", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    const result = collect(channel);
    channel.push(2);
    await Bun.sleep(1);
    channel.push(3);
    channel.close();
    expect(await result).toEqual([1, 2, 3]);
  });

  test("delivers buffered values before the close error", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.close(new Error("boom"));
    const iterator = channel[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(iterator.next()).rejects.toThrow("boom");
  });

  test("refuses pushes after close", () => {
    const channel = new AsyncChannel<number>();
    channel.close();
    expect(channel.push(1)).toBe(false);
  });

  test("an early break closes the channel", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.push(2);
    for await (const _ of channel) break;
    expect(channel.closed).toBe(true);
    expect(channel.push(3)).toBe(false);
  });

  test("returns the same generator on every iteration request", () => {
    const channel = new AsyncChannel<number>();
    expect(channel[Symbol.asyncIterator]()).toBe(channel[Symbol.asyncIterator]());
  });
});
