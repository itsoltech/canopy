import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImmutableImageCache } from "../../apps/mobile/src/storage/image-cache.ts";
import { DiskImageStorage, imageHash } from "../../tests/integration/support/image-cache.ts";

/** Repeatable JS transfer measurement. Visibility/remounts are simulated; no native renderer or RPC transport. */
const directory = await mkdtemp(join(tmpdir(), "canopy-image-bench-"));
const payload = new Uint8Array(16 * 1024).fill(42);
let requests = 0;
let bytes = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    requests++;
    bytes += payload.byteLength;

    return new Response(payload);
  },
});

const read = async (signal: AbortSignal) => new Uint8Array(await (await fetch(server.url, { signal })).arrayBuffer());
const storage = new DiskImageStorage(directory);
let cache = new ImmutableImageCache(storage, imageHash);
const keys = Array.from({ length: 20 }, (_, i) => JSON.stringify(["attachment", `computer-a~${i}`, "thumbnail"]));

async function visit(cached: boolean) {
  // Only these visible images request bytes. Each completed visit leaves/remounts all twenty images.
  for (const key of keys) {
    const signal = new AbortController().signal;

    if (cached) await cache.get(key, read, signal);
    else await read(signal);
  }
}

try {
  for (const cached of [false, true]) {
    requests = 0;
    bytes = 0;

    for (let pass = 0; pass < 3; pass++) await visit(cached);
    console.info(
      JSON.stringify({
        method: cached ? "private disk + memory cache" : "previous per-mount fetch",
        images: 20,
        visits: 3,
        requests,
        bytes,
      }),
    );
  }

  requests = 0;
  bytes = 0;
  cache = new ImmutableImageCache(storage, imageHash);
  await visit(true);
  console.info(JSON.stringify({ method: "process restart, same pairing", requests, bytes }));
} finally {
  await cache.close();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
