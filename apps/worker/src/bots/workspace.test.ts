import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import {
  BOT_FILE_BYTES,
  BOT_RETENTION_MS,
  BOT_WORKSPACE_FILES,
  BotWorkspace,
  botFilename,
  cleanupBotWorkspaces,
} from "./workspace.ts";

const temp = tempDirs();
const workspace = () => new BotWorkspace(temp("canopy-bot-workspace-"));

test("workspace paths cannot escape through traversal, absolute paths, device names or links", async () => {
  const box = workspace();
  const outside = join(temp("canopy-outside-"), "private.txt");
  writeFileSync(outside, "PRIVATE");

  for (const path of [
    "../private.txt",
    "/etc/passwd",
    "C:\\private.txt",
    "folder/private.txt",
    ".",
    "..",
    "nul.txt",
    "note\u0000.txt",
  ])
    expect(() => botFilename(path)).toThrow();

  symlinkSync(outside, join(box.path, "link.txt"));
  await expect(box.read("link.txt")).rejects.toThrow();
  expect(() => box.write("link.txt", Buffer.from("changed"))).toThrow();
  expect(await Bun.file(outside).text()).toBe("PRIVATE");

  const hard = workspace();
  linkSync(outside, join(hard.path, "hard.txt"));
  await expect(hard.read("hard.txt")).rejects.toThrow();
});

test("workspace limits cover replacement, aggregate size and file count without partial writes", async () => {
  const box = workspace();
  const data = Buffer.alloc(BOT_FILE_BYTES);

  for (const name of ["a.bin", "b.bin", "c.bin", "d.bin"]) box.write(name, data);
  expect(() => box.write("overflow.txt", Buffer.from("x"))).toThrow("full");
  expect(existsSync(join(box.path, "overflow.txt"))).toBe(false);
  box.delete("a.bin");
  box.write("a.bin", Buffer.from("note"));
  expect((await box.read("a.bin")).toString()).toBe("note");
  expect(() => box.write("large.bin", Buffer.alloc(BOT_FILE_BYTES + 1))).toThrow("50 MiB");

  const many = workspace();

  for (let i = 0; i < BOT_WORKSPACE_FILES; i++) many.write(`${i}.txt`, Buffer.alloc(0));
  expect(() => many.write("extra.txt", Buffer.alloc(0))).toThrow("full");
});

test("retention skips active and symlinked workspaces and removes expired data after release", () => {
  const root = temp("canopy-bot-retention-");
  const bot = join(root, "bots", crypto.randomUUID());
  const path = join(bot, "workspace");
  mkdirSync(path, { recursive: true });
  const box = new BotWorkspace(path);
  const release = box.hold();
  const future = Date.now() + BOT_RETENTION_MS + 1000;
  cleanupBotWorkspaces(root, future);
  expect(existsSync(path)).toBe(true);
  release();
  utimesSync(path, new Date(0), new Date(0));
  cleanupBotWorkspaces(root, future);
  expect(existsSync(path)).toBe(false);

  const outside = temp("canopy-bot-retention-outside-");
  symlinkSync(outside, path);
  cleanupBotWorkspaces(root, future);
  expect(existsSync(outside)).toBe(true);
});
