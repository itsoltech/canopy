import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewEventSchema, AgentPreviewInputSchema } from "@canopy/contracts";
import { PreviewWatch, previewMetadata } from "./watch.ts";
import { PreviewInputQueue } from "./input-queue.ts";
import type { PreviewBackend } from "./types.ts";
import { validatePreviewInputs } from "./validation.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const input = (kind: string, text = "") => create(AgentPreviewInputSchema, { kind, text });

test("frame ACK only releases the exact outstanding frame; stale heartbeat retains the latest frame", async () => {
  const frames: bigint[] = [];
  const payloads: number[] = [];
  let stops = 0;

  const watch = new PreviewWatch({
    id: "preview",
    threadId: "thread",
    maxFps: 12,
    send: (event) => {
      const parsed = create(AgentPreviewEventSchema, event);

      if (parsed.state === "frame") {
        frames.push(parsed.frameId);
        payloads.push(parsed.data[0] ?? 0);
      }
    },
    stop: () => {
      stops++;
    },
    leaseMs: 1000,
  });

  try {
    watch.offer({ state: "frame", data: new Uint8Array([1]) });
    await tick();
    watch.offer({ state: "frame", data: new Uint8Array([2]) });
    watch.offer({ state: "frame", data: new Uint8Array([3]) });
    watch.ack(0n);
    watch.ack(999n);
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(frames).toEqual([1n]);
    watch.ack(1n);
    await tick();
    expect(frames).toEqual([1n, 2n]);
    expect(payloads).toEqual([1, 3]);
    watch.offer({ state: "frame", data: new Uint8Array([4]) });
    watch.ack(1n);
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    expect(frames).toEqual([1n, 2n]);
    expect(stops).toBe(0);
  } finally {
    watch.close();
  }
});

test("invalidating an automatic frame before dispatch releases the watcher without a client ACK", async () => {
  const frames: string[] = [];
  const sent = Promise.withResolvers<void>();

  const watch = new PreviewWatch({
    id: "automatic",
    threadId: "thread",
    maxFps: 12,
    stop: () => {},
    send: (event) => {
      if (event.state !== "frame") return;
      frames.push(event.targetId!);
      sent.resolve();
    },
  });

  let current = "first";

  const offer = (targetId: string) =>
    watch.offer(
      {
        state: "frame",
        followingAgent: true,
        targetId,
        data: Uint8Array.of(1),
      },
      undefined,
      () => current === targetId,
    );

  try {
    offer("first");
    current = "second";
    await tick();
    expect(watch.capacity).toBe(true);
    offer("second");
    await sent.promise;
    expect(frames).toEqual(["second"]);
  } finally {
    watch.close();
  }
});

test("known ACK heartbeat renews leases; a slow or throwing sender never creates parallel frame sends", async () => {
  let stopped = 0;
  let sends = 0;
  const blocked = Promise.withResolvers<void>();

  const watch = new PreviewWatch({
    id: "slow",
    threadId: "thread",
    maxFps: 12,
    leaseMs: 50,
    send: async (event) => {
      if (event.state === "frame") {
        sends++;
        await blocked.promise;
      }
    },
    stop: () => {
      stopped++;
    },
  });

  watch.offer({ state: "frame", data: new Uint8Array([1]) });
  await tick();
  watch.ack(1n);
  watch.offer({ state: "frame", data: new Uint8Array([2]) });
  await tick();
  expect(sends).toBe(1);
  watch.ack(0n);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(stopped).toBe(0);
  watch.ack(999n);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(stopped).toBe(1);
  watch.close();
  blocked.resolve();

  const throwing = new PreviewWatch({
    id: "broken",
    threadId: "thread",
    maxFps: 1,
    send: () => {
      throw new Error("link lost");
    },
    stop: () => {
      stopped++;
    },
  });

  throwing.offer({ state: "ready" });
  await tick();
  throwing.close();
  expect(stopped).toBe(2);
});

test("revoking one viewer fences its unexecuted tail and preserves the other viewer's input", async () => {
  const blocked = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const released: string[] = [];

  const backend: PreviewBackend = {
    start: async () => {},
    close: async () => {},
    input: async (inputs, owner) => {
      for (const event of inputs) {
        calls.push(`${owner}:${event.kind}`);

        if (owner === "a" && event.kind === "pointer-down") {
          entered.resolve();
          await blocked.promise;
        }
      }
    },
    release: async (owner) => {
      released.push(owner);
    },
  };

  const queue = new PreviewInputQueue(
    async () => backend,
    () => {},
  );

  queue.add("a");
  queue.add("b");
  queue.enqueue("a", [input("pointer-down"), input("key-down"), input("pointer-up")]);
  await entered.promise;
  queue.enqueue("b", [input("text", "hello")]);
  const removed = queue.remove("a");
  blocked.resolve();
  await removed;
  await tick();
  expect(calls).toEqual(["a:pointer-down", "b:text"]);
  expect(released).toEqual(["a"]);
  queue.enqueue("a", [input("text", "revoked")]);
  await queue.close();
  expect(calls).toEqual(["a:pointer-down", "b:text"]);
});

test("queued text and pointer movement coalesce while capability errors remain recoverable", async () => {
  const ready = Promise.withResolvers<PreviewBackend>();
  const calls: string[] = [];
  const errors: string[] = [];

  const queue = new PreviewInputQueue(
    () => ready.promise,
    (owner) => {
      errors.push(owner);
    },
  );

  queue.add("owner");
  queue.enqueue("owner", [input("text", "h"), input("text", "i"), input("pointer-move"), input("pointer-move")]);
  queue.enqueue("owner", [input("key-down"), input("text", "still works")]);
  ready.resolve({
    start: async () => {},
    close: async () => {},
    release: async () => {},
    input: async (inputs) => {
      for (const event of inputs) {
        if (event.kind === "key-down") throw new Error("unsupported key");
        calls.push(event.text || event.kind);
      }
    },
  });
  await tick();
  queue.enqueue("owner", [input("text", "later")]);
  await tick();
  await queue.close();
  expect(calls).toEqual(["hi", "pointer-move", "still works", "later"]);
  expect(errors).toEqual(["owner"]);
});

test("wire bounds reject oversized frames, metadata and input without rejecting sparse protobuf batches", () => {
  expect(() => previewMetadata({ state: "frame", data: new Uint8Array(2 * 1024 * 1024 + 1) })).toThrow("2 MiB");
  expect(() => previewMetadata({ width: 8193 })).toThrow("dimensions");
  expect(() => previewMetadata({ detail: "x".repeat(33 * 1024) })).toThrow("metadata");
  expect(() => validatePreviewInputs(Array.from({ length: 64 }, () => input("release")))).not.toThrow();
  expect(() => validatePreviewInputs([input("text", "€".repeat(2800))])).toThrow();
  expect(() => validatePreviewInputs([create(AgentPreviewInputSchema, { kind: "pointer-down", x: NaN })])).toThrow();
  expect(() => validatePreviewInputs([input("navigate", "file:///private")])).toThrow();
});
