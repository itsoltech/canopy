import { afterEach, expect, test } from "bun:test";
import { isJsonObject } from "@canopy/domain/json";
import { cleanupPromotionFixtures, fixture, now, options } from "./fixtures/promotion.ts";
import { runPromotion } from "./promote.ts";
import type { PromotionAdapters } from "./promotion-data.ts";
import { HOUR } from "./promotion-policy.ts";

afterEach(cleanupPromotionFixtures);

test("dev waits from the first beta push until stable publishes, even with newer green nightly and override", async () => {
  const f = fixture();
  f.release(f.baseline, "v0.5.0");
  const beta = f.commit("feat: next stable series", 200);
  f.release(beta, "v0.6.0-nightly.9");
  const first = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(first.version).toBe("0.6.0-beta.1");
  expect(first.plan.sha).toBe(beta);
  const oldNightly = f.commit("feat: nightly work during the first beta build", 100, "new.ts");
  f.release(oldNightly, "v0.6.0-nightly.10");

  const devOverride = { ...options, override: true };
  const building = await runPromotion("fixture/canopy", "dev-next", devOverride, f.adapters, now);
  expect(building.plan).toMatchObject({ sha: beta, reason: `Waiting for beta publication on next at ${beta}` });
  f.release(beta, "v0.6.0-beta.1");
  f.runs.set(beta, [
    { head_sha: beta, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  const soaking = await runPromotion("fixture/canopy", "dev-next", devOverride, f.adapters, now);
  expect(soaking.plan).toMatchObject({
    sha: beta,
    reason: "Beta v0.6.0-beta.1 is stabilizing; waiting for public stable v0.6.0",
  });
  const stable = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(stable.plan.sha).toBe(beta);
  expect(stable.version).toBe("0.6.0");
  expect((await runPromotion("fixture/canopy", "dev-next", devOverride, f.adapters, now)).plan.sha).toBe(beta);
  f.release(beta, "v0.6.0");
  const closed = await runPromotion("fixture/canopy", "dev-next", devOverride, f.adapters, now);
  expect(closed.plan.sha).toBe(beta);
  expect(closed.input.nightlyFloor).toBe("v0.7.0-nightly.1");
  const commitsAfterBeta = f.commit("feat: new nightly work", 50, "new.ts");
  f.release(commitsAfterBeta, "v0.7.0-nightly.1");
  const resumed = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(resumed.plan.sha).toBe(commitsAfterBeta);
  expect(resumed.version).toBe("0.7.0-beta.1");
  expect(f.writes.some(({ path }) => path.includes("/dispatches"))).toBe(false);
});

test("a beta-only repair blocks fallback while building and then starts soak from its own manifest", async () => {
  const f = fixture();
  const beta = f.commit("feat: stabilizing feature", 200);
  f.release(beta, "v0.2.0-beta.9");
  f.git("push", "origin", `${beta}:refs/heads/next`);
  f.runs.set(beta, [
    { head_sha: beta, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  f.commit("feat: work for the next nightly series", 60, "nightly.ts");
  f.git("checkout", "-B", "next", "origin/next");
  const fix = f.commit("fix: repair beta feature", 54, "feature.ts", "next");
  f.releases.push({ tag_name: "v0.2.0-beta.10", draft: true, prerelease: true });

  const pending = await runPromotion("fixture/canopy", "next-main", { ...options, override: true }, f.adapters, now);
  expect(pending.plan).toMatchObject({
    sha: f.baseline,
    reason: `Waiting for beta publication on next at ${fix}`,
  });
  f.release(fix, "v0.2.0-beta.10", 54, 23);
  f.commit("docs: changes since beta", 4, "readme.md", "next");
  const young = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(young.plan.sha).toBe(f.baseline);
  expect(f.writes).toEqual([]);
  const ready = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now + HOUR);
  expect(ready.plan.sha).toBe(fix);
  expect(ready.version).toBe("0.2.0");
});

test("a beta change merged while the stable promotion is being journaled cancels the push", async () => {
  const f = fixture();
  const beta = f.commit("feat: stabilizing candidate", 200);
  f.release(beta, "v0.2.0-beta.1");
  f.git("push", "origin", `${beta}:refs/heads/next`);
  f.runs.set(beta, [
    { head_sha: beta, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);
  const fix = f.commit("fix: beta correction", 1, "other.ts");

  const adapters: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (path.endsWith("/issues") && method === "POST") f.git("push", "origin", `${fix}:refs/heads/next`);

      return f.adapters.api(path, method, body);
    },
  };

  await expect(runPromotion("fixture/canopy", "next-main", options, adapters, now)).rejects.toThrow(
    "Branch moved while recording promotion intent",
  );
  expect(f.git("rev-parse", "origin/main")).toBe(f.baseline);
  expect(f.git("rev-parse", "origin/next")).toBe(fix);
});

test("stable does not advance to an already soaked patch beta before its predecessor publishes", async () => {
  const f = fixture();
  const first = f.commit("feat: stable candidate", 240);
  const patch = f.commit("fix: late beta correction", 100, "fix.ts");
  f.git("push", "origin", `${first}:refs/heads/main`, `${patch}:refs/heads/next`);
  f.release(first, "v0.2.0-beta.1", 120);
  f.release(patch, "v0.2.1-beta.1", 40);
  f.runs.set(patch, [
    { head_sha: patch, head_branch: "next", status: "completed", conclusion: "success", run_number: 1, run_attempt: 1 },
  ]);

  const pending = await runPromotion("fixture/canopy", "next-main", { ...options, override: true }, f.adapters, now);
  expect(pending.plan).toMatchObject({
    sha: first,
    reason: `Waiting for stable publication on main at ${first}`,
  });
  expect(f.writes).toEqual([]);
  f.release(first, "v0.2.0", 1);
  const ready = await runPromotion("fixture/canopy", "next-main", options, f.adapters, now);
  expect(ready.plan.sha).toBe(patch);
  expect(ready.version).toBe("0.2.1");
});

test("a closed public beta ahead of stable does not freeze the first promotion of the next series", async () => {
  const f = fixture();
  f.release(f.baseline, "v0.5.0");
  const closed = f.commit("fix: newer than stable of the same core", 120);
  f.release(closed, "v0.5.0-beta.1");
  f.git("push", "origin", `${closed}:refs/heads/next`);
  const nightly = f.commit("fix: next minor update", 90, "new.ts");
  f.release(nightly, "v0.6.0-nightly.1");
  const result = await runPromotion("fixture/canopy", "dev-next", options, f.adapters, now);
  expect(result.plan.sha).toBe(nightly);
  expect(result.version).toBe("0.6.0-beta.1");
});

test("automatic recovery dispatches a retired beta once after a version or publication failure", async () => {
  const f = fixture();
  const beta = f.commit("feat: stabilizing candidate", 200);
  f.release(beta, "v0.2.0-beta.1");
  const fix = f.commit("fix: late correction", 120);
  f.git("push", "origin", `${beta}:refs/heads/main`, `${fix}:refs/heads/next`);
  f.git("tag", "v0.2.0-beta.2", fix);
  f.git("push", "origin", "refs/tags/v0.2.0-beta.2");
  f.releases.push({ tag_name: "v0.2.0-beta.2", draft: true, prerelease: true });
  f.runs.set(fix, [
    {
      id: 42,
      event: "push",
      head_sha: fix,
      head_branch: "next",
      status: "completed",
      conclusion: "failure",
      run_number: 42,
      run_attempt: 1,
    },
  ]);
  let checks = "failure";

  const adapters: PromotionAdapters = {
    ...f.adapters,
    api(path, method, body) {
      if (path.includes("/artifacts?")) return { artifacts: [] };

      if (path.includes("/42/jobs?"))
        return {
          jobs: [
            { name: "checks / Typecheck, tests, builds", conclusion: checks },
            { name: "release", conclusion: checks === "success" ? "failure" : "skipped" },
          ],
        };

      if (path.endsWith("/issues") && method === "POST" && isJsonObject(body)) f.issues.push({ ...body, number: 99 });

      return f.adapters.api(path, method, body);
    },
  };

  const automatic = { ...options, automatic: true };
  const run = () => runPromotion("fixture/canopy", "dev-next", automatic, adapters, now);
  await run();
  expect(f.writes).toEqual([]);
  checks = "success";
  f.runs.set(beta, [
    { id: 43, event: "workflow_dispatch", head_branch: "dev", status: "queued", run_number: 43, run_attempt: 1 },
  ]);
  await run();
  expect(f.writes).toEqual([]);
  f.runs.delete(beta);
  await run();
  expect(f.writes.at(-1)).toMatchObject({
    path: "repos/fixture/canopy/actions/workflows/release.yml/dispatches",
    method: "POST",
    body: { ref: "dev", inputs: { release_branch: "next", expected_sha: fix } },
  });
  await run();
  expect(f.writes).toHaveLength(2);
  expect(f.git("rev-parse", "origin/next")).toBe(fix);
});

test("a recorded promotion with no Release run dispatches once after its grace period", async () => {
  for (const branch of ["next", "main"] as const) {
    const path = branch === "next" ? "dev-next" : "next-main";
    const f = fixture();
    const pending = f.commit("feat: pushed candidate", 50);
    f.git(
      "push",
      "origin",
      `${pending}:refs/heads/next`,
      `${pending}:refs/heads/${branch === "next" ? "dev" : "main"}`,
    );

    if (branch === "main") f.release(pending, "v0.2.0-beta.1");

    const receipt = {
      number: 42,
      title: `Promotion history: ${path}`,
      body: `- Soak: 6 h; evaluated at ${new Date(now).toISOString()}\nPushed ${pending} to ${branch}; Release is triggered by the push\n`,
    };

    f.issues.push(receipt);
    const automatic = { ...options, automatic: true };
    await runPromotion("fixture/canopy", path, automatic, f.adapters, now);
    expect(f.writes).toEqual([]);
    await runPromotion("fixture/canopy", path, automatic, f.adapters, now + HOUR);
    expect(f.writes.at(-1)?.body).toEqual({ ref: "dev", inputs: { release_branch: branch, expected_sha: pending } });
  }
});
