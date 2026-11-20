import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BlobChunkSchema } from "@canopy/contracts";
import { PreviewBuffers } from "../src/core/preview-buffers.ts";

function source(workerId: string) {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { workerId, closed: promise, close: resolve };
}

function chunk(id: number, offset = 0, last = false, data = new Uint8Array([65])) {
  return create(BlobChunkSchema, {
    sha256: id.toString(16).padStart(64, "0"),
    threadId: "thread",
    mimeType: "text/plain",
    data,
    offset: BigInt(offset),
    last,
  });
}

test("preview buffers bound one worker across connections and release partial transfers at their deadline", async () => {
  const buffers = new PreviewBuffers(15);
  const first = source("worker");
  const second = source("worker");
  const stored: number[] = [];

  const store = async (bytes: Buffer) => {
    stored.push(bytes.length);
  };

  try {
    for (let i = 0; i < 16; i++) await buffers.receive(first, chunk(i), store);
    await buffers.receive(second, chunk(16, 0, true), store);
    expect(stored).toEqual([]);
    await buffers.receive(first, chunk(0, 1, true), store);
    expect(stored).toEqual([2]);
    await Bun.sleep(30);
    await buffers.receive(first, chunk(1, 1, true), store);
    await buffers.receive(second, chunk(16, 0, true), store);
    expect(stored).toEqual([2, 1]);
  } finally {
    first.close();
    second.close();
  }
});

test("different workers share the process object budget and retained capacities count against their byte budget", async () => {
  const buffers = new PreviewBuffers();
  const workers = Array.from({ length: 17 }, (_, id) => source(String(id)));
  const stored: number[] = [];

  const store = async (bytes: Buffer) => {
    stored.push(bytes.length);
  };

  try {
    for (const worker of workers.slice(0, 16))
      for (let id = 0; id < 16; id++) await buffers.receive(worker, chunk(id), store);

    const last = workers[16]!;
    await buffers.receive(last, chunk(0, 0, true), store);
    expect(stored).toEqual([]);

    for (const worker of workers.slice(0, 16)) worker.close();
    await Promise.all(workers.slice(0, 16).map((worker) => worker.closed));

    const part = new Uint8Array(256 * 1024);

    // Three partial streams retain 4 MiB each. Growing another to 8 MiB would exceed 16 MiB.
    for (let id = 0; id < 3; id++) {
      for (let n = 0; n < 16; n++) await buffers.receive(last, chunk(id, n * part.length, false, part), store);
    }

    await buffers.receive(last, chunk(0, part.length * 16, true), store);
    expect(stored).toEqual([]);
    await buffers.receive(last, chunk(1, part.length * 16, true, new Uint8Array()), store);
    expect(stored).toEqual([4 * 1024 * 1024]);
  } finally {
    for (const worker of workers) worker.close();
  }
});
