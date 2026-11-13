import { expect, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { processGovernor } from "@canopy/process-governor";
import { workspaceOrigin } from "./origin.ts";

test("origin reads coalesce, detect atomic config changes and share a linked worktree's common config", async () => {
  const dir = tempDir("canopy-origin-cache-");
  const repo = join(dir, "repo");
  const linked = join(dir, "linked");

  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir });

    if (result.exitCode) throw new Error(result.stderr.toString());
  };

  git("init", "-q", repo);
  git("-C", repo, "config", "remote.origin.url", "https://example.com/first/repo.git");
  git("-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "initial");
  git("-C", repo, "worktree", "add", "-qb", "linked", linked);
  const started = processGovernor.snapshot().started;
  const values = await Promise.all(Array.from({ length: 100 }, () => workspaceOrigin(repo)));
  expect(values.every((value) => value.workspaceOrigin === "example.com/first/repo")).toBe(true);
  expect(processGovernor.snapshot().started - started).toBe(1);
  writeFileSync(join(repo, ".git", "unrelated.lock"), "index activity");
  await workspaceOrigin(repo);
  expect(processGovernor.snapshot().started - started).toBe(1);
  expect((await workspaceOrigin(linked)).workspaceOrigin).toBe("example.com/first/repo");

  git("-C", repo, "config", "remote.origin.url", "https://example.com/second/repo.git");
  expect((await workspaceOrigin(repo)).workspaceOrigin).toBe("example.com/second/repo");
  expect((await workspaceOrigin(linked)).workspaceOrigin).toBe("example.com/second/repo");
  const replacement = join(repo, ".git", "config.replacement");
  writeFileSync(replacement, '[remote "origin"]\nurl = https://user:secret@example.com/unsafe/repo.git\n');
  renameSync(replacement, join(repo, ".git", "config"));
  expect(await workspaceOrigin(repo, true)).toEqual({
    workspaceOrigin: "example.com/unsafe/repo",
    workspaceCloneUrl: "",
  });
  git("-C", repo, "config", "remote.origin.url", "https://example.com/safe/repo.git");
  expect((await workspaceOrigin(repo)).workspaceCloneUrl).toBe("");
  expect((await workspaceOrigin(repo, true)).workspaceCloneUrl).toBe("https://example.com/safe/repo.git");
  git("-C", repo, "config", "--unset", "remote.origin.url");
  expect(await workspaceOrigin(repo, true)).toEqual({ workspaceOrigin: "", workspaceCloneUrl: "" });
});
