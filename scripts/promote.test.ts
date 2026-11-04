/** Real git mutations are confined to these local bare fixtures; every GitHub request is injected. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@canopy/domain";
import { burnInDays, runPromotion, type PromotionOptions } from "./promote.ts";
import { loadPromotion, type PromotionAdapters } from "./promotion-data.ts";
import { DAY } from "./promotion-policy.ts";

const dirs: string[] = [];
const now = Date.parse("2026-11-10T12:00:00Z");
const options: PromotionOptions = { dryRun: false, paused: false, override: false, burnIn: 3 };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
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

  const releases: JsonValue[] = [],
    issues: JsonValue[] = [],
    blockers: JsonValue[] = [];

  const pulls = new Map<string, JsonValue[]>();
  const runs = new Map<string, JsonValue[]>();
  const writes: { path: string; method: string; body: JsonValue | undefined }[] = [];

  const adapters: PromotionAdapters = {
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
      const sha = new URL(`https://fixture.invalid/${path}`).searchParams.get("head_sha")!;

      return { workflow_runs: runs.get(sha) ?? [] };
    },
    pages(path) {
      if (path.includes("/releases?")) return releases;

      if (path.includes("labels=release-blocker")) return blockers;

      if (path.includes("/issues?")) return issues;
      const match = /\/commits\/([^/]+)\/pulls/.exec(path);

      if (match) return pulls.get(match[1]!) ?? [];
      throw new Error(`Unexpected fixture API read: ${path}`);
    },
  };

  function commit(message: string, ageHours: number, file = "feature.ts") {
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
        head_branch: "dev",
        status: "completed",
        conclusion: "success",
        run_number: 1,
        run_attempt: 1,
      },
    ]);
    git("push", "origin", "dev");

    return sha;
  }

  function release(sha: string, tag: string, ageHours = 100, manifestAgeHours = ageHours) {
    git("tag", tag, sha);
    releases.push({
      tag_name: tag,
      draft: false,
      prerelease: true,
      published_at: new Date(now - ageHours * 3_600_000).toISOString(),
      assets: [{ name: "manifest.json", updated_at: new Date(now - manifestAgeHours * 3_600_000).toISOString() }],
    });
  }

  return { git, baseline, remote, commit, release, adapters, writes, issues, blockers, pulls, runs };
}

test("promotes an ancestor with a fully soaked fix, dispatches its SHA, and leaves newer dev commits behind", async () => {
  const f = fixture();
  f.commit("feat: original", 50);
  const fix = f.commit("fix: correction", 49);
  f.release(fix, "v0.2.0-nightly.2");
  const head = f.commit("feat: newer unrelated", 1, "other.ts");
  const result = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(result.plan.sha).toBe(fix);
  expect(result.version).toBe("0.2.0-beta.1");
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(fix);
  expect(f.git("ls-remote", "origin", "refs/heads/dev")).toStartWith(head);
  expect(f.writes.find((write) => write.path.includes("/dispatches"))?.body).toEqual({
    ref: "next",
    inputs: { expected_sha: fix },
  });
});

test("dry-run, pause, blockers, docs-only and empty ranges never mutate git or GitHub", async () => {
  for (const scenario of ["dry", "pause", "blocker", "docs", "empty"]) {
    const f = fixture();

    if (scenario !== "empty") {
      const sha = f.commit(scenario === "docs" ? "docs: explain a feature" : "feat: original", 50);
      f.release(sha, "v0.2.0-nightly.1");
    }

    if (scenario === "blocker") f.blockers.push({ number: 7 });

    const result = await runPromotion(
      "fixture/canopy",
      "dev-next",
      { ...options, dryRun: scenario === "dry", paused: scenario === "pause" },
      f.adapters,
      now,
    );

    expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(f.baseline);
    expect(f.writes).toEqual([]);

    if (scenario !== "dry") expect(result.plan.sha).toBe(f.baseline);
  }
});

test("merged PR hold and explicit PR body links hold a feature; starvation issue is created or updated", async () => {
  const f = fixture();
  const feature = f.commit("feat: original", 240, "a.ts");
  f.release(feature, "v0.2.0-nightly.1");
  const fix = f.commit("fix: follow-up", 1, "b.ts");
  f.pulls.set(feature, [
    { number: 68, body: "", merged_at: "2026-11-01", merge_commit_sha: feature, base: { ref: "dev" }, labels: [] },
  ]);
  f.pulls.set(fix, [
    { number: 69, body: "Refs: #68", merged_at: "2026-11-10", merge_commit_sha: fix, base: { ref: "dev" }, labels: [] },
  ]);
  const held = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(held.plan.sha).toBe(f.baseline);
  expect(held.plan.holds[0]?.reason).toContain("explicit PR #68");
  expect(f.writes.at(-1)?.method).toBe("POST");
  expect(JSON.stringify(f.writes.at(-1)?.body)).toContain("Promotion stalled: dev-next");
  f.issues.push({ number: 12, title: "Promotion stalled: dev-next" });
  await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(f.writes.at(-1)?.path).toEndWith("/issues/12");
  expect(f.writes.at(-1)?.method).toBe("PATCH");

  f.pulls.set(feature, [
    {
      number: 68,
      body: "",
      merged_at: "2026-11-01",
      merge_commit_sha: feature,
      base: { ref: "dev" },
      labels: [{ name: "promotion-hold" }],
    },
  ]);
  f.pulls.set(fix, []);
  expect(
    (await runPromotion("fixture/canopy", "dev-next", { ...options, dryRun: true }, f.adapters, now)).plan.holds[0]
      ?.reason,
  ).toBe("promotion-hold");
});

test("stable promotes an older published beta and measures burn-in from the manifest, not merge time", async () => {
  const f = fixture();
  const old = f.commit("feat: original", 200, "a.ts");
  const young = f.commit("feat: later beta", 150, "b.ts");
  f.release(old, "v0.2.0-beta.1", 100, 73);
  f.release(young, "v0.2.0-beta.2", 90, 24);
  f.git("push", "origin", `${young}:refs/heads/next`);

  for (const sha of [old, young])
    f.runs.set(sha, [
      { head_sha: sha, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
    ]);
  const result = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(result.plan.sha).toBe(old);
  expect(result.version).toBe("0.2.0");
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(old);
});

test("diverged histories and concurrent target changes cannot result in a non-fast-forward promotion", async () => {
  const f = fixture();
  const sha = f.commit("feat: source", 50);
  f.release(sha, "v0.2.0-nightly.1");
  f.git("checkout", "next");
  f.git("commit", "--allow-empty", "-m", "fix: target hotfix");
  const hotfix = f.git("rev-parse", "HEAD");
  f.git("push", "origin", `${hotfix}:refs/heads/racer`);

  const racing: PromotionAdapters = {
    ...f.adapters,
    git(...args) {
      if (args[0] === "push") execFileSync("git", ["update-ref", "refs/heads/next", hotfix], { cwd: f.remote });

      return f.git(...args);
    },
  };

  await expect(runPromotion("fixture/canopy", "dev-next", options, racing, now)).rejects.toThrow();
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(hotfix);
  expect(f.writes.some((write) => write.path.includes("dispatches"))).toBe(false);
  f.git("fetch", "origin");
  expect(() => loadPromotion("fixture/canopy", "dev-next", DAY, f.adapters, now)).toThrow();
});

test("latest failed CI wins over older green CI and manual override cannot bypass it", async () => {
  const f = fixture();
  const sha = f.commit("feat: original", 1);
  f.release(sha, "v0.2.0-nightly.1");
  const green = f.runs.get(sha)![0]!;
  f.runs.set(sha, [
    green,
    { head_sha: sha, head_branch: "dev", status: "completed", conclusion: "failure", run_number: 2, run_attempt: 1 },
  ]);
  expect(
    (await runPromotion("fixture/canopy", "dev-next", { ...options, override: true }, f.adapters, now)).plan.sha,
  ).toBe(f.baseline);
  expect(f.writes).toEqual([]);
});

test("manual override bypasses soak/pause/hold and still uses the same fast-forward and release checks", async () => {
  const f = fixture();
  const sha = f.commit("feat: urgent", 1);
  f.release(sha, "v0.2.0-nightly.1", 1);
  f.pulls.set(sha, [
    {
      number: 68,
      body: "",
      merged_at: "2026-11-10",
      merge_commit_sha: sha,
      base: { ref: "dev" },
      labels: [{ name: "promotion-hold" }],
    },
  ]);
  expect(
    (await runPromotion("fixture/canopy", "dev-next", { ...options, paused: true, override: true }, f.adapters, now))
      .plan.sha,
  ).toBe(sha);
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(sha);

  for (const value of ["-1", "1.5", "NaN", "366"]) expect(() => burnInDays(value)).toThrow();
});

test("a failed dispatch is resumed from the journal even after target catches up to source", async () => {
  const f = fixture();
  const sha = f.commit("feat: original", 50);
  f.release(sha, "v0.2.0-nightly.1");

  const broken: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (path.includes("/dispatches")) throw new Error("GitHub dispatch unavailable");

      return f.adapters.api(path, method, body);
    },
  };

  await expect(runPromotion("fixture/canopy", "dev-next", options, broken, now)).rejects.toThrow(
    "dispatch unavailable",
  );
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(sha);
  const pending = f.writes.find((write) => write.path.endsWith("/issues"))?.body;
  f.issues.push({ number: 99, title: "Promotion history: dev-next", body: JSON.parse(JSON.stringify(pending)).body });
  const result = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(result.plan.sha).toBe(sha);
  expect(f.writes.find((write) => write.path.includes("/dispatches"))?.body).toEqual({
    ref: "next",
    inputs: { expected_sha: sha },
  });
  const status = JSON.stringify(f.writes.at(-1)?.body);
  expect(status).toContain("Release dispatched");
  expect(status).toContain("Candidate C0");
  expect(status).not.toContain("canopy-promotion-pending");
});

test("untagged fallback requires all four successful smoke jobs; skipped smoke cannot promote", async () => {
  const f = fixture();
  const sha = f.commit("feat: no tag", 50);

  const skipped: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (path.includes("/jobs?")) return { jobs: [{ name: "smoke (linux-x64, fixture)", conclusion: "skipped" }] };

      return f.adapters.api(path, method, body);
    },
  };

  expect((await runPromotion("fixture/canopy", "dev-next", options, skipped, now)).plan.sha).toBe(f.baseline);
  expect(f.writes).toEqual([]);
  expect((await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now)).plan.sha).toBe(sha);
});

test("pending publication is rechecked and held if its original gets a fix after the successful push", async () => {
  const f = fixture();
  const feature = f.commit("feat: pending feature", 50);
  f.release(feature, "v0.2.0-nightly.1");
  f.git("push", "origin", `${feature}:refs/heads/next`);
  f.issues.push({
    number: 99,
    title: "Promotion history: dev-next",
    body: `- Target: ${f.baseline}\n<!-- canopy-promotion-pending: ${feature} -->`,
  });
  f.commit(`fix: repair pending feature\n\nRefs: ${feature}`, 1, "other.ts");
  await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(f.writes).toEqual([]);
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(feature);
});

test("forecast advances beta counters and a fully reverted range produces no release", async () => {
  const f = fixture();
  const first = f.commit("feat: original", 100);
  f.release(first, "v0.2.0-nightly.1");
  await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  f.release(first, "v0.2.0-beta.1");
  const fix = f.commit("fix: correction", 50);
  f.release(fix, "v0.2.0-nightly.2");
  expect((await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now)).version).toBe("0.2.0-beta.2");
  const reverted = fixture();
  const feature = reverted.commit("feat: original", 100);
  const revert = reverted.commit(`revert: feat: original\n\nThis reverts commit ${feature}.`, 50);
  reverted.release(revert, "v0.1.1-nightly.1");
  expect((await runPromotion("fixture/canopy", "dev-next", options, reverted.adapters, now)).plan.sha).toBe(
    reverted.baseline,
  );
  expect(reverted.writes).toEqual([]);
});

test("the real commitlint configuration accepts documented fix, perf and revert footers", () => {
  const messages = [
    "fix(worker): handle reconnect\n\nFixes: #68\n",
    "perf(worker): avoid repeated work\n\nRefs: abc1234567890\n",
    "revert: restore reconnect\n\nThis reverts commit abc1234567890.\n",
  ];

  for (const message of messages)
    execFileSync("bun", ["run", "commitlint"], {
      cwd: join(import.meta.dir, ".."),
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
    });
});

test("stable is held by a known dev fix that has not been published as beta", async () => {
  const f = fixture();
  const beta = f.commit("feat: beta feature", 200);
  f.release(beta, "v0.2.0-beta.1", 100);
  f.git("push", "origin", `${beta}:refs/heads/next`);
  f.runs.set(beta, [
    { head_sha: beta, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  f.commit(`fix: pending beta repair\n\nRefs: ${beta}`, 1, "other.ts");
  const result = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(result.plan.sha).toBe(f.baseline);
  expect(result.plan.holds[0]?.reason).toContain("explicit SHA");
  expect(f.writes).toEqual([]);
});

test("a stable hotfix reached through a second-parent backmerge is retained during promotion", async () => {
  const f = fixture();
  const feature = f.commit("feat: beta feature", 200, "feature.ts");
  f.git("checkout", "main");
  f.git("commit", "--allow-empty", "-m", "fix: stable hotfix");
  const hotfix = f.git("rev-parse", "HEAD");
  f.git("tag", "v0.1.1", hotfix);
  f.git("push", "origin", "main");
  f.git("checkout", "dev");
  f.git("merge", "--no-ff", "main", "-m", "chore(release): propagate hotfix");
  const merged = f.git("rev-parse", "HEAD");
  f.git("push", "origin", "dev", `${merged}:refs/heads/next`);
  f.release(feature, "v0.2.0-beta.1", 150);
  f.release(merged, "v0.2.0-beta.2", 100);

  for (const sha of [feature, merged])
    f.runs.set(sha, [
      { head_sha: sha, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
    ]);
  const result = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(result.plan.sha).toBe(merged);
  expect(result.version).toBe("0.2.0");
  expect(f.git("merge-base", hotfix, merged)).toBe(hotfix);
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(merged);
});

test("dry-run forecasts the next soaked prefix using current CI and hold evidence only", async () => {
  const f = fixture();
  f.commit("feat: original", 24.5);
  const fix = f.commit("fix: feature repair", 23.5);
  f.release(fix, "v0.2.0-nightly.2");
  const result = await runPromotion("fixture/canopy", "dev-next", { ...options, dryRun: true }, f.adapters, now);
  expect(result.plan.sha).toBe(f.baseline);
  expect(result.next).toEqual({ at: now + 0.5 * 3_600_000, sha: fix, version: "0.2.0-beta.1" });
  expect(f.writes).toEqual([]);

  const paused = await runPromotion(
    "fixture/canopy",
    "dev-next",
    { ...options, dryRun: true, paused: true },
    f.adapters,
    now,
  );

  expect(paused.next).toBeUndefined();
});
