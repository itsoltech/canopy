import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseMirror } from "./mirror.ts";
import { ReleaseSource, type ReleaseManifest } from "./release.ts";
import { pruneReleaseCache } from "./retention.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "canopy-release-retention-"));
  directories.push(directory);
  const releases: ReleaseManifest[] = [];

  for (let i = 1; i <= 7; i++) {
    const bytes = `worker ${i}`;

    const manifest: ReleaseManifest = {
      schema: 1,
      version: `1.0.${i}`,
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
          url: "https://example.com/worker",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: Buffer.byteLength(bytes),
        },
      ],
    };

    const path = join(directory, `manifest-${manifest.version}.json`);
    await writeFile(path, JSON.stringify(manifest));
    await utimes(path, i, i);
    await writeFile(join(directory, manifest.assets[0]!.sha256), bytes);
    releases.push(manifest);
  }

  return { directory, releases };
}

test("a restarted mirror keeps the running release and two most recent releases for offline use", async () => {
  const { directory, releases } = await fixture();
  await writeFile(join(directory, "f".repeat(64)), "orphan");
  await pruneReleaseCache(directory, new Set(["1.0.1"]));
  const names = await readdir(directory);

  expect(names.filter((name) => name.startsWith("manifest-")).sort()).toEqual([
    "manifest-1.0.1.json",
    "manifest-1.0.6.json",
    "manifest-1.0.7.json",
  ]);
  expect(names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort()).toEqual(
    [releases[0]!, releases[5]!, releases[6]!].map((release) => release.assets[0]!.sha256).sort(),
  );

  const mirror = new ReleaseMirror(
    directory,
    "1.0.1",
    new ReleaseSource({
      fetch: async () => {
        throw new Error("offline");
      },
    }),
  );

  expect(await Bun.file(await mirror.artifact("linux", "x64")).text()).toBe("worker 1");
});

test("current, rollback and staged releases beat recency; shared hashes and unrelated files survive", async () => {
  const { directory, releases } = await fixture();
  const current = releases[0]!;
  const shared = releases[6]!.assets[0]!;
  current.assets.push({ ...shared, os: "darwin", arch: "arm64", name: "canopy-worker-darwin-arm64" });
  await writeFile(join(directory, "manifest-1.0.1.json"), JSON.stringify(current));
  const partial = `${"f".repeat(64)}.download.part`;
  await writeFile(join(directory, partial), "unfinished");
  await writeFile(join(directory, "manifest-1.0.9.json.pending.tmp"), "unfinished manifest");
  await writeFile(join(directory, "unrelated"), "keep");
  await mkdir(join(directory, "e".repeat(64)));
  await symlink(join(directory, "unrelated"), join(directory, "d".repeat(64)));
  await pruneReleaseCache(directory, new Set(["1.0.1", "1.0.2", "1.0.3"]));
  const names = await readdir(directory);

  expect(names.filter((name) => name.startsWith("manifest-") && name.endsWith(".json")).sort()).toEqual([
    "manifest-1.0.1.json",
    "manifest-1.0.2.json",
    "manifest-1.0.3.json",
  ]);
  expect(names).toContain(shared.sha256);
  expect(names).toContain(partial);
  expect(names).toContain("manifest-1.0.9.json.pending.tmp");
  expect(names).toContain("unrelated");
  expect(names).toContain("e".repeat(64));
  expect(names).toContain("d".repeat(64));
});

test("required releases may exceed the release budget", async () => {
  const { directory } = await fixture();
  await pruneReleaseCache(directory, new Set(["1.0.1", "1.0.2", "1.0.3", "1.0.4"]));
  expect((await readdir(directory)).filter((name) => name.startsWith("manifest-")).length).toBe(4);
});

test("an unpublished build or an uncached rollback release does not block cleanup of complete releases", async () => {
  const { directory } = await fixture();
  await pruneReleaseCache(directory, new Set(["0.0.0-dev", "1.0.9", "1.0.1"]));
  expect((await readdir(directory)).filter((name) => name.startsWith("manifest-")).sort()).toEqual([
    "manifest-1.0.1.json",
    "manifest-1.0.6.json",
    "manifest-1.0.7.json",
  ]);
  expect((await readdir(directory)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length).toBe(3);
});

test("corrupt or mismatched manifests cannot cause deletion", async () => {
  const { directory } = await fixture();
  const names = (await readdir(directory)).sort();
  await writeFile(join(directory, "manifest-1.0.1.json"), "{");
  await expect(pruneReleaseCache(directory, new Set(["1.0.1"]))).rejects.toThrow();
  expect((await readdir(directory)).sort()).toEqual(names);
  await writeFile(
    join(directory, "manifest-1.0.1.json"),
    await Bun.file(join(directory, "manifest-1.0.2.json")).text(),
  );
  await expect(pruneReleaseCache(directory, new Set(["1.0.1"]))).rejects.toThrow("filename");
  expect((await readdir(directory)).sort()).toEqual(names);
});
