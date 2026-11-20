/** Git mutations happen in an isolated bare remote. GitHub reads and writes use in-memory fixtures. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject, type JsonValue } from "@canopy/domain";
import type { PromotionOptions } from "../promote.ts";
import type { PromotionAdapters } from "../promotion-data.ts";

const dirs: string[] = [];
export const now = Date.parse("2026-11-10T12:00:00Z");
export const options: PromotionOptions = { dryRun: false, paused: false, override: false, burnIn: 1 };

export function cleanupPromotionFixtures() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "canopy-promote-unit-"));
  dirs.push(dir);

  const remote = join(dir, "origin.git"),
    cwd = join(dir, "checkout");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("config", "user.name", "Promotion fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "commit.gpgSign", "false");
  git("config", "tag.gpgSign", "false");
  git("config", "tag.forceSignAnnotated", "false");
  git("commit", "--allow-empty", "-m", "chore: bootstrap");
  git("tag", "v0.1.0");
  git("branch", "next");
  git("checkout", "-b", "dev");
  git("push", "origin", "main", "next", "dev", "--tags");
  const baseline = git("rev-parse", "HEAD");

  const releases: JsonValue[] = [{ tag_name: "v0.1.0", draft: false, prerelease: false }],
    issues: JsonValue[] = [],
    blockers: JsonValue[] = [];

  const pulls = new Map<string, JsonValue[]>();
  const runs = new Map<string, JsonValue[]>();
  const writes: { path: string; method: string; body: JsonValue | undefined }[] = [];

  const adapters: PromotionAdapters = {
    releaseRevision() {
      throw new Error("Push runs do not need revision artifacts");
    },
    git,
    api(path, method = "GET", body) {
      if (method !== "GET") {
        writes.push({ path, method, body });

        return { number: 99 };
      }

      if (path.includes("/jobs?"))
        return {
          jobs: ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].map((target) => ({
            name: `smoke (${target}, fixture)`,
            conclusion: "success",
          })),
        };
      const page = Number(new URL(`https://fixture.invalid/${path}`).searchParams.get("page") ?? 1);

      return { workflow_runs: [...runs.values()].flat().slice((page - 1) * 100, page * 100) };
    },
    pages(path) {
      if (path.includes("/releases?")) return releases;

      if (path.includes("labels=release-blocker")) return blockers;

      if (path.includes("/issues?")) return issues;

      if (path.includes("/pulls?")) {
        const base = new URL(`https://fixture.invalid/${path}`).searchParams.get("base");

        return [...pulls.values()]
          .flat()
          .filter((pr) => isJsonObject(pr) && isJsonObject(pr["base"]) && pr["base"]["ref"] === base);
      }

      throw new Error(`Unexpected fixture API read: ${path}`);
    },
  };

  function commit(message: string, ageHours: number, file = "feature.ts", branch = "dev") {
    writeFileSync(join(cwd, file), `${message}\n${ageHours}\n`);
    git("add", ".");
    const date = new Date(now - ageHours * 3_600_000).toISOString();
    execFileSync("git", ["commit", "-m", message], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "pipe",
    });
    const sha = git("rev-parse", "HEAD");
    runs.set(sha, [
      {
        id: 1,
        head_sha: sha,
        head_branch: branch,
        status: "completed",
        conclusion: "success",
        run_number: 1,
        run_attempt: 1,
      },
    ]);
    git("push", "origin", branch);

    return sha;
  }

  function release(sha: string, tag: string, ageHours = 100, manifestAgeHours = ageHours) {
    git("tag", "-a", tag, sha, "-m", tag);
    git("push", "origin", `refs/tags/${tag}`);
    releases.push({
      tag_name: tag,
      draft: false,
      prerelease: tag.includes("-"),
      published_at: new Date(now - ageHours * 3_600_000).toISOString(),
      assets: [{ name: "manifest.json", updated_at: new Date(now - manifestAgeHours * 3_600_000).toISOString() }],
    });
  }

  return { git, baseline, remote, commit, release, releases, adapters, writes, issues, blockers, pulls, runs };
}
