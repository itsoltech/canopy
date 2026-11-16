import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseSource, type ReleaseManifest } from "@canopy/updater";
import { GatewayReleaseMirror, UpdateCache } from "./cache.ts";

const caches: UpdateCache[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const cache of caches.splice(0)) {
    await cache.prune();
    cache.close();
  }

  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "canopy-gateway-cache-"));
  directories.push(directory);
  const logs: string[] = [];
  const cache = new UpdateCache(directory, (message) => logs.push(message));
  caches.push(cache);

  return { directory, cache, logs };
}

function manifest(version: string): ReleaseManifest {
  return {
    schema: 1,
    version,
    channel: "stable",
    commit: "abcdef0",
    published_at: "2026-11-03T00:00:00Z",
    protocol: { worker_link: 1, update: 1 },
    assets: [
      {
        app: "worker",
        os: "linux",
        arch: "x64",
        name: "canopy-worker-linux-x64",
        url: `https://example.com/${version}`,
        sha256: createHash("sha256").update(`worker ${version}`).digest("hex"),
        size: Buffer.byteLength(`worker ${version}`),
      },
    ],
  };
}

test("cleanup waits for active downloads across mirrors, then reclaims old releases without touching a stream", async () => {
  const { directory, cache } = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();

  const source = new ReleaseSource({
    fetch: async (input) => {
      const version = new URL(String(input)).pathname.slice(1);

      if (version === "1.0.7") {
        entered.resolve();
        await resume.promise;
      }

      return new Response(`worker ${version}`);
    },
  });

  cache.retain("1.0.1");
  const current = new GatewayReleaseMirror(cache, "1.0.1", source);

  for (let i = 1; i <= 6; i++) {
    const mirror = new GatewayReleaseMirror(cache, `1.0.${i}`, source);
    await mirror.remember(manifest(mirror.version));
    await mirror.artifact("linux", "x64");
    await utimes(join(directory, `manifest-${mirror.version}.json`), i, i);
  }

  const streamPath = await current.artifact("linux", "x64");
  const stream = Bun.file(streamPath).stream().getReader();
  const release = cache.retain("1.0.7");
  const staged = new GatewayReleaseMirror(cache, "1.0.7", source);
  await staged.remember(manifest(staged.version));
  const download = staged.artifact("linux", "x64");
  await entered.promise;
  await cache.startRetention(source.options);
  await cache.prune();
  expect((await readdir(directory)).filter((name) => name.startsWith("manifest-")).length).toBe(7);
  resume.resolve();
  expect(await Bun.file(await download).text()).toBe("worker 1.0.7");
  await cache.prune();
  expect((await readdir(directory)).filter((name) => name.startsWith("manifest-")).sort()).toEqual([
    "manifest-1.0.1.json",
    "manifest-1.0.6.json",
    "manifest-1.0.7.json",
  ]);
  expect(new TextDecoder().decode((await stream.read()).value)).toBe("worker 1.0.1");
  expect(await Bun.file(streamPath).exists()).toBe(true);
  await stream.cancel();
  release();
});

test("failed maintenance does not break verified downloads or cached reuse", async () => {
  const { directory, cache, logs } = await fixture();
  const source = new ReleaseSource({ fetch: async () => new Response("worker 1.0.1") });
  cache.retain("1.0.1");
  const mirror = new GatewayReleaseMirror(cache, "1.0.1", source);
  await mirror.remember(manifest(mirror.version));
  await writeFile(join(directory, "manifest-1.0.2.json"), "corrupt manifest");
  await cache.startRetention(source.options);
  const path = await mirror.artifact("linux", "x64");
  expect(await Bun.file(path).text()).toBe("worker 1.0.1");
  expect(await mirror.artifact("linux", "x64")).toBe(path);
  await cache.prune();
  expect(logs).toEqual(["Could not finish pruning the update cache; updates can continue"]);
});
