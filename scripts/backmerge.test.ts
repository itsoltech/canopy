/** Branch pushes stay in a local bare fixture; GitHub writes are injected. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@canopy/domain";
import { runBackmerge } from "./backmerge.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "canopy-backmerge-unit-"));
  directories.push(directory);
  const remote = join(directory, "origin.git");
  const cwd = join(directory, "checkout");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("config", "user.name", "Back-merge fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "commit.gpgSign", "false");
  writeFileSync(join(cwd, "feature.ts"), "baseline\n");
  git("add", ".");
  git("commit", "-m", "chore: bootstrap fixture");
  git("branch", "next");
  git("branch", "dev");
  const baseline = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, "feature.ts"), "stable hotfix\n");
  git("commit", "-am", "fix: stable hotfix");
  const stable = git("rev-parse", "HEAD");
  git("push", "origin", "main", "next", "dev");
  const dispatches: { repo: string; branch: string; sha: string }[] = [];
  const pulls: JsonValue[] = [];

  const adapters = {
    git,
    api(_path: string, method = "GET", body?: JsonValue) {
      if (method === "POST" && body) pulls.push(body);

      return [];
    },
    dispatchRelease(repo: string, branch: string, sha: string) {
      dispatches.push({ repo, branch, sha });
    },
  };

  return { cwd, git, baseline, stable, dispatches, pulls, adapters };
}

test("back-merge pushes next and dev but dispatches Release only for dev at its exact merge SHA", () => {
  const f = fixture();
  runBackmerge("fixture/canopy", f.stable, f.adapters);
  const beta = f.git("rev-parse", "origin/next");
  const dev = f.git("rev-parse", "origin/dev");
  expect(f.git("rev-parse", `${beta}^1`)).toBe(f.baseline);
  expect(f.git("rev-parse", `${beta}^2`)).toBe(f.stable);
  expect(f.git("rev-parse", `${dev}^2`)).toBe(beta);
  expect(f.dispatches).toEqual([{ repo: "fixture/canopy", branch: "dev", sha: dev }]);
  expect(f.pulls).toEqual([]);

  runBackmerge("fixture/canopy", f.stable, f.adapters);
  expect(f.git("rev-parse", "origin/dev")).toBe(dev);
  expect(f.dispatches).toHaveLength(1);
});

test("a conflict opens a PR without pushing or dispatching either downstream branch", () => {
  const f = fixture();
  f.git("checkout", "next");
  writeFileSync(join(f.cwd, "feature.ts"), "beta change\n");
  f.git("commit", "-am", "feat: beta change");
  f.git("push", "origin", "next");
  const beta = f.git("rev-parse", "origin/next");

  runBackmerge("fixture/canopy", f.stable, f.adapters);
  expect(f.git("rev-parse", "origin/next")).toBe(beta);
  expect(f.git("rev-parse", "origin/dev")).toBe(f.baseline);
  expect(f.dispatches).toEqual([]);
  expect(f.pulls).toEqual([expect.objectContaining({ head: "main", base: "next" })]);
});
