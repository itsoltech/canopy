import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ListThreadDiffSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { ThreadDiffs } from "./thread-diff.ts";
import { copyDiffSource } from "./diff-source.ts";

const temp = tempDirs();

test("snapshot copies refuse traversal, leaf links and parent links without retaining outside bytes", () => {
  const directory = temp("canopy-diff-security-");
  const root = join(directory, "root");
  const privateDirectory = join(directory, "private");
  mkdirSync(root);
  mkdirSync(privateDirectory);
  writeFileSync(join(privateDirectory, "private.txt"), "private contents");
  symlinkSync(privateDirectory, join(root, "parent"));
  symlinkSync(join(privateDirectory, "private.txt"), join(root, "leaf.txt"));
  const target = join(directory, "snapshot");

  for (const path of ["../private/private.txt", ".git/config", "parent/private.txt", "leaf.txt"])
    expect(() => copyDiffSource(root, path, target, { bytes: 0, signal: new AbortController().signal })).toThrow();
  expect(existsSync(target)).toBe(false);
});

test("worker restart removes private snapshots left by an interrupted process", async () => {
  const directory = temp("canopy-diff-restart-");
  const stale = join(directory, "diff-snapshots", "snapshot-interrupted");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "0.lines"), "private old patch");
  const snapshots = new ThreadDiffs(directory);
  expect(existsSync(stale)).toBe(false);
  await snapshots.close();
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });

  if (result.exitCode !== 0) throw new Error("Git fixture failed");

  return result.stdout.toString().trim();
}

test.skipIf(process.platform === "win32")(
  "missing promised objects cannot launch a repository remote helper",
  async () => {
    const directory = temp("canopy-diff-promisor-");
    const root = join(directory, "repository");
    const marker = join(directory, "remote-helper-ran");
    const helper = join(directory, "remote-helper");
    mkdirSync(root);
    git(root, "init", "-q");
    writeFileSync(join(root, "tracked.txt"), "missing previous contents\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "initial");
    const oid = git(root, "rev-parse", "HEAD:tracked.txt");
    unlinkSync(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    unlinkSync(join(root, "tracked.txt"));
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(helper, 0o755);
    git(root, "config", "core.repositoryFormatVersion", "1");
    git(root, "config", "extensions.partialClone", "origin");
    git(root, "config", "remote.origin.promisor", "true");
    git(root, "config", "remote.origin.url", `ext::${helper}`);
    git(root, "config", "protocol.ext.allow", "always");
    const snapshots = new ThreadDiffs(join(directory, "worker"));

    try {
      await expect(
        snapshots.list(create(ListThreadDiffSchema, { ownerId: "owner", threadId: "thread", workspace: root })),
      ).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      // Without the backend guard, this same missing object invokes the configured helper.
      const unguarded = { ...process.env };
      delete unguarded["GIT_NO_LAZY_FETCH"];
      const attempted = Bun.spawnSync(["git", "cat-file", "blob", oid], { cwd: root, env: unguarded, timeout: 2000 });
      expect(attempted.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await snapshots.close();
    }
  },
);
