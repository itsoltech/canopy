/** Real git mutations are confined to these local bare fixtures; every GitHub request is injected. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isJsonObject } from "@canopy/domain";
import { burnInDays, promotionSummary, runPromotion } from "./promote.ts";
import { loadPromotion, type PromotionAdapters } from "./promotion-data.ts";
import { finishPromotion, preparePromotion } from "./promotion-journal.ts";
import { DAY, HOLD_CAP_DAYS } from "./promotion-policy.ts";

import { cleanupPromotionFixtures, fixture, now, options } from "./fixtures/promotion.ts";

afterEach(cleanupPromotionFixtures);

test("promotes a soaked ancestor, relies on the push for Release, and leaves newer dev commits behind", async () => {
  const f = fixture();
  f.commit("feat: original", 50);
  const fix = f.commit("fix: correction", 6);
  f.release(fix, "v0.2.0-nightly.2");
  const head = f.commit("feat: newer unrelated", 1, "other.ts");
  const result = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(result.plan.sha).toBe(fix);
  expect(result.version).toBe("0.2.0-beta.1");
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(fix);
  expect(f.git("ls-remote", "origin", "refs/heads/dev")).toStartWith(head);
  expect(f.writes.some((write) => write.path.includes("/dispatches"))).toBe(false);
  expect(JSON.stringify(f.writes.at(-1)?.body)).toContain(`Pushed ${fix} to next; Release is triggered by the push`);
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

test("stable measures burn-in from the exact beta manifest even as newer nightly publishes", async () => {
  const f = fixture();
  const old = f.commit("feat: original", 200, "a.ts");
  const young = f.commit("feat: later beta", 150, "b.ts");
  f.release(old, "v0.2.0-beta.1", 100, 24);
  f.release(old, "v0.2.0-nightly.1");
  f.release(young, "v0.2.0-beta.2", 90, 23);
  f.release(young, "v0.2.0-nightly.2");
  const newer = f.commit("feat: next nightly series", 100, "nightly.ts");
  f.release(newer, "v0.10.0-nightly.1");
  f.git("push", "origin", `${young}:refs/heads/next`);

  for (const sha of [old, young])
    f.runs.set(sha, [
      { head_sha: sha, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
    ]);
  const waiting = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(waiting.plan.sha).toBe(f.baseline);
  expect(f.writes).toEqual([]);
  const result = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now + 3_600_000);
  expect(result.plan.sha).toBe(young);
  expect(result.version).toBe("0.2.0");
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(young);
  expect(f.writes.some((write) => write.path.includes("/dispatches"))).toBe(false);
});

test("stable reports the failed Release attempt and its required job once the public beta has soaked", async () => {
  const f = fixture();
  const beta = f.commit("feat: beta feature", 50);
  const tag = "v0.2.0-beta.1";
  f.release(beta, tag, 48, 24);
  f.git("push", "origin", `${beta}:refs/heads/next`);
  const push = { id: 42, head_sha: beta, head_branch: "next", status: "completed", run_number: 42 };
  f.runs.set(beta, [
    { ...push, run_attempt: 2, conclusion: "failure" },
    { ...push, run_attempt: 1, conclusion: "success" },
  ]);
  const runUrl = "https://github.com/fixture/canopy/actions/runs/42";
  const jobReads: string[] = [];

  const adapters: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (!path.includes("/jobs?")) return f.adapters.api(path, method, body);
      jobReads.push(path);

      return {
        jobs: [
          { name: "desktop (linux-arm64, ubuntu-24.04-arm, true)", conclusion: "failure", html_url: `${runUrl}/job/1` },
          {
            name: "desktop-smoke (linux-arm64, ubuntu-24.04-arm, true)",
            conclusion: "failure",
            html_url: `${runUrl}/job/2`,
          },
          { name: "desktop (linux-arm64) / package", conclusion: "failure", html_url: `${runUrl}/job/3` },
          { name: "publish-desktop", conclusion: "success" },
          { name: "backmerge / backmerge", conclusion: "failure", html_url: `${runUrl}/job/4` },
        ],
      };
    },
  };

  const automatic = { ...options, automatic: true };
  const young = await runPromotion("fixture/canopy", "next-main", automatic, adapters, now - 1);
  expect(young.plan.reason).toBe(`Waiting for eligible beta ${tag}`);
  expect(jobReads).toEqual([]);
  const result = await runPromotion("fixture/canopy", "next-main", automatic, adapters, now);
  expect(jobReads).toEqual(["repos/fixture/canopy/actions/runs/42/attempts/2/jobs?per_page=100&page=1"]);
  expect(result.plan.reason).toContain(`Stable v0.2.0 is blocked because Release failed for ${tag} at ${beta}`);
  expect(result.plan.reason).toContain(`[Release attempt 2](${runUrl}/attempts/2)`);
  expect(result.plan.reason).toContain(`Required job [backmerge / backmerge](${runUrl}/job/4) failed.`);
  expect(result.plan.reason).toContain(
    `Optional job [desktop (linux-arm64, ubuntu-24.04-arm, true)](${runUrl}/job/1) failed.`,
  );
  expect(result.plan.reason).toContain(
    `Optional job [desktop-smoke (linux-arm64, ubuntu-24.04-arm, true)](${runUrl}/job/2) failed.`,
  );
  expect(result.plan.reason).toContain(`Optional job [desktop (linux-arm64) / package](${runUrl}/job/3) failed.`);
  expect(result.plan.sha).toBe(f.baseline);
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(f.baseline);
  expect(f.writes).toEqual([]);
});

test("a new beta during promotion recheck invalidates the plan even if its SHA is unchanged", async () => {
  for (const override of [false, true]) {
    const f = fixture();
    const beta = f.commit("feat: promoted beta", 200);
    f.release(beta, "v0.2.0-beta.9");
    f.git("push", "origin", `${beta}:refs/heads/next`);
    f.runs.set(beta, [
      {
        head_sha: beta,
        head_branch: "next",
        status: "completed",
        conclusion: "success",
        run_number: 1,
        run_attempt: 1,
      },
    ]);
    let listings = 0;

    const adapters: PromotionAdapters = {
      ...f.adapters,
      pages(path) {
        if (path.includes("/releases?") && ++listings === 2) f.release(beta, "v0.2.0-beta.10", 1);

        return f.adapters.pages(path);
      },
    };

    await expect(runPromotion("fixture/canopy", "next-main", { ...options, override }, adapters, now)).rejects.toThrow(
      "Promotion gates changed during selection",
    );
    expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(f.baseline);
    expect(f.writes).toEqual([]);
  }
});

test("stable dry-run selects the exact recovered beta despite a later retry of the older push", async () => {
  const f = fixture();
  const beta = f.commit("feat: recovered beta", 200);
  const workflowSha = f.commit("ci: recovery tooling", 190, "tooling.ts");
  f.release(beta, "v0.2.0-beta.1", 100);
  f.release(beta, "v0.2.0-nightly.1");
  f.git("push", "origin", `${beta}:refs/heads/next`);
  f.runs.set(beta, [
    {
      id: 333,
      event: "push",
      head_branch: "next",
      head_sha: beta,
      status: "completed",
      conclusion: "cancelled",
      run_number: 333,
      run_attempt: 2,
    },
    {
      id: 335,
      event: "workflow_dispatch",
      head_branch: "dev",
      head_sha: workflowSha,
      status: "completed",
      conclusion: "success",
      run_number: 335,
      run_attempt: 1,
    },
  ]);
  f.runs.delete(workflowSha);

  const adapters: PromotionAdapters = {
    ...f.adapters,
    releaseRevision: () => ({ sha: beta, branch: "next" }),
    api(path, method, body) {
      if (path.includes("/335/artifacts?"))
        return { artifacts: [{ id: 12, name: "release-revision", expired: false }] };

      if (path.includes("/335/jobs?"))
        return {
          jobs: ["Verified CI", "release", "publish-desktop"].map((name) => ({ name, conclusion: "success" })),
        };

      return f.adapters.api(path, method, body);
    },
  };

  const result = await runPromotion("fixture/canopy", "next-main", { ...options, dryRun: true }, adapters, now);
  expect(result.plan.sha).toBe(beta);
  expect(result.plan.reason).toBe("Ready");
  expect(result.version).toBe("0.2.0");
  expect(promotionSummary(result.input, result.plan, result.version)).toContain(
    "Candidate recovery Release: https://github.com/fixture/canopy/actions/runs/335/attempts/1; exact-SHA gate: passed",
  );
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(f.baseline);
  expect(f.writes).toEqual([]);

  f.pulls.set(beta, [
    {
      number: 68,
      body: "",
      merged_at: "2026-11-01",
      merge_commit_sha: beta,
      base: { ref: "dev" },
      labels: [{ name: "promotion-hold" }],
    },
  ]);
  const held = await runPromotion("fixture/canopy", "next-main", { ...options, dryRun: true }, adapters, now);
  expect(held.plan.sha).toBe(f.baseline);
  expect(promotionSummary(held.input, held.plan)).toContain("exact-SHA gate: passed");
  expect(held.plan.holds[0]?.reason).toBe("promotion-hold");
  expect(f.writes).toEqual([]);
});

test("diverged histories and concurrent target changes cannot result in a non-fast-forward promotion", async () => {
  const f = fixture();
  const sha = f.commit("feat: source", 50);
  f.release(sha, "v0.2.0-nightly.1");
  f.git("checkout", "next");
  f.git("commit", "--allow-empty", "-m", "docs: target change");
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
  await expect(loadPromotion("fixture/canopy", "dev-next", DAY, f.adapters, now)).rejects.toThrow();
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

test("a failed history update is repaired without dispatching or pushing again after target catches source", async () => {
  const f = fixture();
  const sha = f.commit("feat: original", 50);
  f.release(sha, "v0.2.0-nightly.1");

  const broken: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (method === "PATCH") throw new Error("GitHub history update unavailable");

      return f.adapters.api(path, method, body);
    },
  };

  await expect(runPromotion("fixture/canopy", "dev-next", options, broken, now)).rejects.toThrow(
    "history update unavailable",
  );
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(sha);
  const pending = f.writes.find((write) => write.path.endsWith("/issues"))?.body;
  f.issues.push({ number: 99, title: "Promotion history: dev-next", body: JSON.parse(JSON.stringify(pending)).body });

  const recovered: PromotionAdapters = {
    ...f.adapters,
    git(...args) {
      if (args[0] === "push") throw new Error("Recovery must not push again");

      return f.git(...args);
    },
  };

  const result = await runPromotion("fixture/canopy", "dev-next", options, recovered, now);
  expect(result.plan.sha).toBe(sha);
  expect(f.writes.some((write) => write.path.includes("/dispatches"))).toBe(false);
  const status = JSON.stringify(f.writes.at(-1)?.body);
  expect(status).toContain("Release is triggered by the push");
  expect(status).toContain("Candidate C0");
  expect(status).not.toContain("canopy-promotion-pending");
});

test("a large promotion backlog fits the GitHub issue before and after the push", () => {
  const f = fixture();
  const summary = `Candidate: ${f.baseline}\n${"- Included commit with a long subject\n".repeat(2_000)}`;
  const pending = preparePromotion("fixture/canopy", "next-main", f.baseline, summary, f.adapters);
  expect(pending.body.length).toBeLessThanOrEqual(65_536);
  expect(pending.body).toContain(`<!-- canopy-promotion-pending: ${f.baseline} -->`);
  finishPromotion("fixture/canopy", "main", f.baseline, pending, f.adapters);
  const update = f.writes.at(-1)?.body;
  const receipt = isJsonObject(update) ? update["body"] : undefined;
  expect(receipt).toBeString();
  expect(String(receipt).length).toBeLessThanOrEqual(65_536);
  expect(receipt).toContain(`Candidate: ${f.baseline}`);
  expect(receipt).toContain(`Pushed ${f.baseline} to main`);
  expect(receipt).not.toContain("canopy-promotion-pending");
});

test("a green but untagged dev commit cannot open a beta series after public stable", async () => {
  const f = fixture();
  f.commit("feat: no tag", 50);
  const result = await runPromotion("fixture/canopy", "dev-next", { ...options, override: true }, f.adapters, now);
  expect(result.plan.sha).toBe(f.baseline);
  expect(f.writes).toEqual([]);
});

test("a fix after a successful push cannot cause history recovery to dispatch another Release", async () => {
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
  expect(f.writes.some((write) => write.path.includes("/dispatches"))).toBe(false);
  expect(JSON.stringify(f.writes.at(-1)?.body)).toContain("Release is triggered by the push");
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(feature);
});

test("a fully reverted range produces no release", async () => {
  const reverted = fixture();
  const feature = reverted.commit("feat: original", 100);
  const revert = reverted.commit(`revert: feat: original\n\nThis reverts commit ${feature}.`, 50);
  reverted.release(revert, "v0.2.0-nightly.1");
  expect((await runPromotion("fixture/canopy", "dev-next", options, reverted.adapters, now)).plan.sha).toBe(
    reverted.baseline,
  );
  expect(reverted.writes).toEqual([]);
});

test("promotion forecasts retain the new minor opened by a fix-only nightly", async () => {
  const f = fixture();
  f.release(f.baseline, "v0.5.0");
  const fix = f.commit("fix: first releasable change after stable", 100);
  f.release(fix, "v0.6.0-nightly.1");
  expect((await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now)).version).toBe("0.6.0-beta.1");
  f.release(fix, "v0.6.0-beta.1");
  f.runs.set(fix, [
    { head_sha: fix, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  expect(
    (await runPromotion("fixture/canopy", "next-main", { ...options, dryRun: true }, f.adapters, now)).version,
  ).toBe("0.6.0");
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
  f.release(beta, "v0.2.0-nightly.1");
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

test("automatic beta expires a linked hold, reports it in the plan and journal, and leaves the fix for later", async () => {
  const f = fixture();
  const feature = f.commit("feat: original", 30);
  f.release(feature, "v0.2.0-nightly.1");
  const fix = f.commit(`fix: pending repair\n\nRefs: ${feature}`, 1, "other.ts");
  const automatic = { ...options, holdCapDays: HOLD_CAP_DAYS };
  const held = await runPromotion("fixture/canopy", "dev-next", automatic, f.adapters, now);
  expect(held.plan.sha).toBe(f.baseline);
  expect(held.plan.expiredHolds).toEqual([]);
  expect(f.writes).toEqual([]);
  const expired = await runPromotion("fixture/canopy", "dev-next", automatic, f.adapters, now + 1);
  expect(expired.plan.sha).toBe(feature);
  expect(expired.plan.holds).toEqual([]);
  expect(promotionSummary(expired.input, expired.plan)).toContain(`hold expired after 1 d: ${fix}: explicit SHA`);
  expect(JSON.stringify(f.writes)).toContain("hold expired after 1 d:");
  expect(JSON.stringify(f.writes)).not.toContain("Promotion stalled:");
  expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(feature);
  expect(f.git("ls-remote", "origin", "refs/heads/dev")).toStartWith(fix);
});

test("automatic stable expires a known dev fix only after one day of beta eligibility", async () => {
  const f = fixture();
  const beta = f.commit("feat: beta feature", 240);
  f.release(beta, "v0.2.0-beta.1", 48);
  f.release(beta, "v0.2.0-nightly.1");
  f.git("push", "origin", `${beta}:refs/heads/next`);
  f.runs.set(beta, [
    { head_sha: beta, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  const fix = f.commit(`fix: pending repair\n\nRefs: ${beta}`, 1, "other.ts");
  const automatic = { ...options, holdCapDays: HOLD_CAP_DAYS };
  const held = await runPromotion("fixture/canopy", "next-main", automatic, f.adapters, now);
  expect(held.plan.sha).toBe(f.baseline);
  expect(held.plan.holds[0]?.since).toBe(now - DAY);
  const expired = await runPromotion("fixture/canopy", "next-main", automatic, f.adapters, now + 1);
  expect(expired.plan.sha).toBe(beta);
  expect(promotionSummary(expired.input, expired.plan)).toContain(`hold expired after 1 d: ${fix}: explicit SHA`);
  expect(f.git("ls-remote", "origin", "refs/heads/main")).toStartWith(beta);
});

test("automatic labels and release-blockers never expire and still create or update stalled issues", async () => {
  for (const gate of ["label", "blocker"]) {
    const f = fixture();
    const feature = f.commit("feat: original", 240);
    f.release(feature, "v0.2.0-nightly.1");

    if (gate === "blocker") f.blockers.push({ number: 7 });
    else
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
    const automatic = { ...options, holdCapDays: HOLD_CAP_DAYS };
    const result = await runPromotion("fixture/canopy", "dev-next", automatic, f.adapters, now);
    expect(result.plan.sha).toBe(f.baseline);
    expect(result.plan.starved).toBe(true);
    expect(result.plan.expiredHolds).toEqual([]);
    expect(JSON.stringify(f.writes.at(-1)?.body)).toContain("Promotion stalled: dev-next");
    f.issues.push({ number: 12, title: "Promotion stalled: dev-next" });
    await runPromotion("fixture/canopy", "dev-next", automatic, f.adapters, now);
    expect(f.writes.at(-1)?.path).toEndWith("/issues/12");
    expect(f.writes.at(-1)?.method).toBe("PATCH");
    expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(f.baseline);
  }
});

test("dry-run leaves pending history untouched and never dispatches Release", async () => {
  const f = fixture();
  const feature = f.commit("feat: pending feature", 100);
  f.release(feature, "v0.2.0-nightly.1");
  f.git("push", "origin", `${feature}:refs/heads/next`);
  f.issues.push({
    number: 99,
    title: "Promotion history: dev-next",
    body: `- Target: ${f.baseline}\n<!-- canopy-promotion-pending: ${feature} -->`,
  });
  f.commit(`fix: pending repair\n\nRefs: ${feature}`, 1, "other.ts");
  await runPromotion("fixture/canopy", "dev-next", { ...options, dryRun: true }, f.adapters, now);
  expect(f.writes).toEqual([]);
});

test("a stable hotfix reached through a second-parent backmerge is retained during promotion", async () => {
  const f = fixture();
  const feature = f.commit("feat: beta feature", 200, "feature.ts");
  f.git("checkout", "main");
  f.git("commit", "--allow-empty", "-m", "fix: stable hotfix");
  const hotfix = f.git("rev-parse", "HEAD");
  f.release(hotfix, "v0.1.1");
  f.git("push", "origin", "main");
  f.git("checkout", "dev");
  f.git("merge", "--no-ff", "main", "-m", "chore(release): propagate hotfix");
  const merged = f.git("rev-parse", "HEAD");
  f.git("push", "origin", "dev", `${merged}:refs/heads/next`);
  f.release(feature, "v0.2.0-beta.1", 150);
  f.release(merged, "v0.2.0-beta.2", 100);
  f.release(merged, "v0.2.0-nightly.1");

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
  f.commit("feat: original", 6.5);
  const fix = f.commit("fix: feature repair", 5.5);
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

test("dry-run forecasts strict hold expiry before the pending fix soaks", async () => {
  const f = fixture();
  const feature = f.commit("feat: original", 30);
  f.release(feature, "v0.2.0-nightly.1");
  f.commit(`fix: pending repair\n\nRefs: ${feature}`, 1, "other.ts");

  const result = await runPromotion(
    "fixture/canopy",
    "dev-next",
    { ...options, dryRun: true, holdCapDays: HOLD_CAP_DAYS },
    f.adapters,
    now,
  );

  expect(result.next).toEqual({ at: now + 1, sha: feature, version: "0.2.0-beta.1" });
  expect(f.writes).toEqual([]);
});

test("fresh blockers, PR holds, follow-up bodies and CI failures abort the pre-push recheck", async () => {
  for (const gate of ["blocker", "label", "body", "removed-link", "ci"]) {
    const f = fixture();
    const feature = f.commit("feat: original", 50);
    f.release(feature, "v0.2.0-nightly.1");
    const fix = f.commit("fix: correction", 1, gate === "removed-link" ? "feature.ts" : "other.ts");

    if (gate === "removed-link")
      f.pulls.set(fix, [
        {
          number: 69,
          body: `Refs: ${"f".repeat(40)}`,
          merged_at: "2026-11-10",
          merge_commit_sha: fix,
          base: { ref: "dev" },
          labels: [],
        },
      ]);
    f.pulls.set(feature, [
      { number: 68, body: "", merged_at: "2026-11-01", merge_commit_sha: feature, base: { ref: "dev" }, labels: [] },
    ]);

    const racing: PromotionAdapters = {
      ...f.adapters,
      git(...args) {
        if (args[0] === "fetch" && args.includes("--tags")) {
          if (gate === "blocker") f.blockers.push({ number: 7 });

          if (gate === "label")
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

          if (gate === "body")
            f.pulls.set(fix, [
              {
                number: 69,
                body: "Fixes: #68",
                merged_at: "2026-11-10",
                merge_commit_sha: fix,
                base: { ref: "dev" },
                labels: [],
              },
            ]);

          if (gate === "removed-link") f.pulls.set(fix, []);

          if (gate === "ci")
            f.runs.set(feature, [
              {
                head_sha: feature,
                head_branch: "dev",
                status: "completed",
                conclusion: "failure",
                run_number: 2,
                run_attempt: 1,
              },
            ]);
        }

        return f.git(...args);
      },
    };

    await expect(runPromotion("fixture/canopy", "dev-next", options, racing, now)).rejects.toThrow(
      "Promotion gates changed during selection",
    );
    expect(f.git("ls-remote", "origin", "refs/heads/next")).toStartWith(f.baseline);
    expect(f.writes).toEqual([]);
  }
});
