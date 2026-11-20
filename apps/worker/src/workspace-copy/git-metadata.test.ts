import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { copyGitConfig, copyGitMetadata } from "./git-metadata.ts";

const temporary = tempDirs();

test("a copy keeps history and checkout state but not local Git policy", () => {
  for (const path of [
    ".git",
    ".git/HEAD",
    ".git/index",
    ".git/packed-refs",
    ".git/refs/heads/main",
    ".git/logs/HEAD",
    ".git/info/exclude",
    `.git/objects/${"ab"}`,
    `.git/objects/ab/${"c".repeat(38)}`,
    `.git/objects/pack/pack-${"1".repeat(40)}.pack`,
  ])
    expect(copyGitMetadata(path)).toBe(true);

  for (const path of [
    ".git/hooks/pre-commit",
    ".git/config.worktree",
    ".git/objects/info/alternates",
    ".git/info/attributes",
    ".git/modules/x/config",
  ])
    expect(copyGitMetadata(path)).toBe(false);
});

test("the portable config keeps remotes and line endings and drops executable policy", async () => {
  const dir = temporary("canopy-copy-config-");
  const config = join(dir, "config");
  writeFileSync(
    config,
    [
      "[core]",
      "\tautocrlf = input",
      "\tfsmonitor = /tmp/monitor",
      "\thooksPath = /tmp/hooks",
      "[alias]",
      "\tst = !echo hi",
      '[filter "lfs"]',
      "\tclean = tool clean",
      '[remote "origin"]',
      "\turl = https://example.com/org/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[remote "leaky"]',
      "\turl = https://user:secret@example.com/org/repo.git",
      '[branch "main"]',
      "\tremote = origin",
      "\tmerge = refs/heads/main",
      "",
    ].join("\n"),
  );

  const portable = join(dir, "portable");
  const text = (await copyGitConfig(config, dir)).toString();
  writeFileSync(portable, text);
  const value = (key: string) => execFileSync("git", ["config", "--file", portable, "--get", key]).toString().trim();

  expect(value("core.autocrlf")).toBe("input");
  expect(value("remote.origin.url")).toBe("https://example.com/org/repo.git");
  expect(value("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  expect(value("branch.main.merge")).toBe("refs/heads/main");
  expect(text).not.toMatch(/fsmonitor|hooksPath|alias|filter|clean|secret|leaky/);
});
