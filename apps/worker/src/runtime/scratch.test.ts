import { expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@open-agents/testing";
import { ensureScratchDirectory } from "./scratch.ts";
const makeTemp = tempDirs();

test("scratch directories are created privately and retained on repeated creation", async () => {
  const root = makeTemp("oa-scratch-worker-");
  const cwd = join(root, ".open-agents", "scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
  ensureScratchDirectory(cwd, [root]);
  await Bun.write(join(cwd, "keep.txt"), "kept");
  ensureScratchDirectory(cwd, [root]);
  expect(await Bun.file(join(cwd, "keep.txt")).text()).toBe("kept");
  if (process.platform !== "win32") expect(statSync(cwd).mode & 0o777).toBe(0o700);
});

test("scratch creation refuses traversal, outside roots and symlinks before writing there", () => {
  const root = makeTemp("oa-scratch-safe-");
  const outside = makeTemp("oa-scratch-outside-");
  const suffix = join(".open-agents", "scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
  expect(() => ensureScratchDirectory(join(outside, suffix), [root])).toThrow("outside");
  expect(existsSync(join(outside, ".open-agents"))).toBe(false);
  expect(() => ensureScratchDirectory(join(root, ".open-agents", "scratch", "..", "escape"), [root])).toThrow("invalid scratch");
  mkdirSync(join(root, ".open-agents"));
  symlinkSync(outside, join(root, ".open-agents", "scratch"), "dir");
  expect(() => ensureScratchDirectory(join(root, suffix), [root])).toThrow("real directories");
  expect(existsSync(join(outside, suffix.split(/[\\/]/)[2]!))).toBe(false);
});
