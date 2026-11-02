import { expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@open-agents/testing";
import { ensureScratchDirectory } from "./scratch.ts";
const makeTemp = tempDirs();

test("scratch directories are created privately and retained on repeated creation", async () => {
  const root = makeTemp("oa-scratch-worker-");
  const cwd = join(root, "scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
  ensureScratchDirectory(cwd, join(root, "scratch"));
  await Bun.write(join(cwd, "keep.txt"), "kept");
  ensureScratchDirectory(cwd, join(root, "scratch"));
  expect(await Bun.file(join(cwd, "keep.txt")).text()).toBe("kept");
  if (process.platform !== "win32") expect(statSync(cwd).mode & 0o777).toBe(0o700);
});

test("managed scratch creation refuses traversal and symlinks before writing there; existing legacy cwd stays valid", () => {
  const root = makeTemp("oa-scratch-safe-");
  const outside = makeTemp("oa-scratch-outside-");
  const suffix = join("scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
  expect(() => ensureScratchDirectory(join(outside, suffix), join(root, "scratch"))).toThrow();
  expect(existsSync(join(outside, "scratch"))).toBe(false);
  expect(() => ensureScratchDirectory(join(root, "scratch", "..", "escape"), join(root, "scratch"))).toThrow("invalid scratch");
  symlinkSync(outside, join(root, "scratch"), "dir");
  expect(() => ensureScratchDirectory(join(root, suffix), join(root, "scratch"))).toThrow("real directories");
  expect(existsSync(join(outside, suffix.split(/[\\/]/)[1]!))).toBe(false);
  const legacy = join(outside, ".open-agents", "scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
  mkdirSync(legacy, { recursive: true });
  ensureScratchDirectory(legacy, join(root, "scratch"));
  expect(statSync(legacy).isDirectory()).toBe(true);
});
