import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { git } from "./git.ts";

const temporary = tempDirs();
const run = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

test("status and diff report normal changes without running repository hooks or filters", async () => {
  const dir = temporary("canopy-git-read-policy-");
  const marker = join(dir, "marker");
  run(dir, ["init", "-q"]);
  run(dir, ["config", "user.email", "t@example.com"]);
  run(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  run(dir, ["add", "a.txt"]);
  run(dir, ["commit", "-q", "-m", "first"]);

  // Repository-local policy that would run a command if a read honored it.
  const command = `touch ${JSON.stringify(marker.replaceAll("\\", "/"))}`;
  run(dir, ["config", "core.fsmonitor", command]);
  run(dir, ["config", "filter.probe.clean", command]);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=probe\n");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "two\n");
  writeFileSync(join(dir, "new.txt"), "fresh\n");

  const status = await git(dir, ["status", "--porcelain=v1"]);
  const diff = await git(dir, ["diff", "--stat"]);
  const history = await git(dir, ["log", "--oneline"]);

  expect([status.ok, diff.ok, history.ok]).toEqual([true, true, true]);
  expect(status.stdout).toContain("a.txt");
  expect(status.stdout).toContain("new.txt");
  expect(diff.stdout).toContain("a.txt");
  expect(history.stdout).toContain("first");
  expect(existsSync(marker)).toBe(false);
});
