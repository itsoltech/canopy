import { describe, expect, test } from "bun:test";
import { AsyncChannel } from "./channel.ts";

describe("AsyncChannel", () => {
  test("delivers values pushed before and after the consumer starts", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    const iterator = channel[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    const second = iterator.next();
    channel.push(2);
    expect(await second).toEqual({ value: 2, done: false });
    const third = iterator.next();
    channel.push(3);
    channel.close();
    expect(await third).toEqual({ value: 3, done: false });
    expect((await iterator.next()).done).toBe(true);
  });

  test("delivers buffered values before the close error", async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.close(new Error("boom"));
    const iterator = channel[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    await expect(iterator.next()).rejects.toThrow("boom");
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
