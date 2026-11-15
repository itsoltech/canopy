import { describe, expect, test } from "bun:test";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { desktopStorageOptions } from "../src/desktop-storage.ts";
import { StorageSampler } from "../src/storage.ts";
import { workerStorageOptions } from "../src/worker-storage.ts";

describe("bounded storage sampler", () => {
  test("uses the deepest category root and counts hardlinks once", async () => {
    const root = tempDir("canopy-storage-overlap-");
    const nested = join(root, "logs");
    await mkdir(nested);
    await writeFile(join(root, "data.bin"), Buffer.alloc(11));
    await writeFile(join(nested, "worker.log"), Buffer.alloc(13));
    await link(join(nested, "worker.log"), join(root, "same-inode.bin"));

    const sampler = new StorageSampler({
      roots: [
        { path: root, category: "data" },
        { path: nested, category: "logs" },
      ],
      minIntervalMs: 0,
    });

    const snapshot = await sampler.refresh();

    expect(snapshot.status).toBe("ready");
    expect(snapshot.categories).toEqual([
      { category: "logs", bytes: 13n },
      { category: "data", bytes: 11n },
    ]);
  });

  test("skips symlink entries and refuses a symlinked root ancestor", async () => {
    const root = tempDir("canopy-storage-links-");
    const outside = tempDir("canopy-storage-outside-");
    await writeFile(join(outside, "secret"), Buffer.alloc(97));
    await symlink(outside, join(root, "linked"));

    const sampler = new StorageSampler({
      roots: [{ path: root, category: "data" }],
      minIntervalMs: 0,
    });

    expect((await sampler.refresh()).categories).toEqual([]);

    const alias = join(root, "alias", "nested");
    await mkdir(join(root, "alias"));
    await symlink(outside, join(root, "alias", "nested"));
    const unsafe = new StorageSampler({ roots: [{ path: alias, category: "data" }], minIntervalMs: 0 });

    expect((await unsafe.refresh()).categories).toEqual([]);
  });

  test("marks a scan partial at the entry budget and coalesces concurrent refreshes", async () => {
    const root = tempDir("canopy-storage-bounds-");
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(root, String(index)), "x")));

    const sampler = new StorageSampler({
      roots: [{ path: root, category: "data" }],
      maxEntries: 4,
      minIntervalMs: 0,
    });

    const first = sampler.refresh();
    const second = sampler.refresh();

    expect(first).toBe(second);
    expect((await first).status).toBe("partial");
  });

  test("treats optional missing roots as a successful zero-sized scan", async () => {
    const root = tempDir("canopy-storage-missing-");

    const sampler = new StorageSampler({
      roots: [{ path: join(root, "optional"), category: "cache" }],
      minIntervalMs: 0,
    });

    expect(await sampler.refresh()).toMatchObject({ status: "ready", categories: [] });
  });

  test("prunes absolute exclusions even when they are nested below a broad root", async () => {
    const root = tempDir("canopy-storage-excluded-");
    const excluded = join(root, "projects");
    await mkdir(excluded);
    await writeFile(join(root, "owned"), Buffer.alloc(5));
    await writeFile(join(excluded, "private"), Buffer.alloc(101));

    const sampler = new StorageSampler({
      roots: [{ path: root, category: "data" }],
      excluded: [excluded],
      minIntervalMs: 0,
    });

    expect((await sampler.refresh()).categories).toEqual([{ category: "data", bytes: 5n }]);
  });

  test("worker roots retain provider project transcripts but omit unmanaged and working directories", async () => {
    const dataDir = tempDir("canopy-storage-worker-");
    await mkdir(join(dataDir, "claude-home", "projects"), { recursive: true });
    await mkdir(join(dataDir, "homes", "claude-id", "projects"), { recursive: true });
    await mkdir(join(dataDir, "scratch"), { recursive: true });
    await mkdir(join(dataDir, "worktrees"), { recursive: true });
    await mkdir(join(dataDir, "bots", "id", "workspace"), { recursive: true });
    await mkdir(join(dataDir, "unknown-project"), { recursive: true });
    await mkdir(join(dataDir, "workspace-copies"), { recursive: true });
    await writeFile(join(dataDir, "owned"), Buffer.alloc(5));
    await writeFile(join(dataDir, "claude-home", "projects", "transcript"), Buffer.alloc(7));
    await writeFile(join(dataDir, "homes", "claude-id", "projects", "transcript"), Buffer.alloc(11));
    await writeFile(join(dataDir, "scratch", "discarded"), Buffer.alloc(13));
    await writeFile(join(dataDir, "worktrees", "discarded"), Buffer.alloc(17));
    await writeFile(join(dataDir, "bots", "id", "workspace", "discarded"), Buffer.alloc(19));
    await writeFile(join(dataDir, "unknown-project", "discarded"), Buffer.alloc(23));
    await writeFile(join(dataDir, "workspace-copies", "receipt"), Buffer.alloc(29));

    const sampler = new StorageSampler({ ...workerStorageOptions({ dataDir }), minIntervalMs: 0 });

    expect((await sampler.refresh()).categories).toEqual([{ category: "data", bytes: 47n }]);
  });

  test("desktop roots include retained worker state, classify nested logs/database, and omit project data", async () => {
    const directory = tempDir("canopy-storage-desktop-");
    await mkdir(join(directory, "local-worker", "data", "codex-home"), { recursive: true });
    await mkdir(join(directory, "local-worker", "data", "thread-secrets"), { recursive: true });
    await mkdir(join(directory, "local-worker", "data", "scratch"), { recursive: true });
    await mkdir(join(directory, "local-worker", "data", "unknown-project"), { recursive: true });
    await mkdir(join(directory, "local-worker", "data", "bots", "id", "workspace"), { recursive: true });
    await mkdir(join(directory, "remote-workers", "hash", "data", "codex-home"), { recursive: true });
    await mkdir(join(directory, "postgres", "data"), { recursive: true });
    await mkdir(join(directory, "logs"), { recursive: true });
    await mkdir(join(directory, "project"), { recursive: true });
    await writeFile(join(directory, "local-worker", "data", "journal.db"), Buffer.alloc(17));
    await writeFile(join(directory, "local-worker", "data", "codex-home", "state"), Buffer.alloc(19));
    await writeFile(join(directory, "local-worker", "data", "thread-secrets", "secret"), Buffer.alloc(23));
    await writeFile(join(directory, "remote-workers", "hash", "data", "codex-home", "state"), Buffer.alloc(43));
    await writeFile(join(directory, "local-worker", "data", "scratch", "discarded"), Buffer.alloc(29));
    await writeFile(join(directory, "local-worker", "data", "unknown-project", "discarded"), Buffer.alloc(31));
    await writeFile(join(directory, "local-worker", "data", "bots", "id", "workspace", "discarded"), Buffer.alloc(37));
    await writeFile(join(directory, "project", "discarded"), Buffer.alloc(41));
    await writeFile(join(directory, "postgres", "data", "base"), Buffer.alloc(13));
    await writeFile(join(directory, "logs", "worker.log"), Buffer.alloc(11));

    const sampler = new StorageSampler({ ...desktopStorageOptions(directory), minIntervalMs: 0 });
    const snapshot = await sampler.refresh();

    expect(snapshot.categories).toEqual([
      { category: "database", bytes: 13n },
      { category: "logs", bytes: 11n },
      { category: "data", bytes: 102n },
    ]);
  });
});
