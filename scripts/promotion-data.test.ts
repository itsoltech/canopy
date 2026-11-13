import { expect, test } from "bun:test";
import type { JsonValue } from "@canopy/domain/json";
import { loadPromotion, type PromotionAdapters } from "./promotion-data.ts";
import { DAY, selectPromotion } from "./promotion-policy.ts";

test("a 555-commit range keeps paginated exact-commit gates within the API budget", () => {
  const history = Array.from({ length: 555 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
  const target = "0".repeat(40);
  const now = Date.parse("2026-11-13T12:00:00Z");

  const runs: JsonValue[] = history.map((sha, i) => ({
    id: i + 1,
    head_sha: sha,
    head_branch: "dev",
    status: "completed",
    conclusion: "success",
    run_number: i + 1,
    run_attempt: 1,
  }));

  // An older green run cannot override a newer failed attempt. Other branches cannot prove dev readiness.
  runs.push({
    id: 555,
    head_sha: history[554]!,
    head_branch: "dev",
    status: "completed",
    conclusion: "failure",
    run_number: 555,
    run_attempt: 2,
  });
  runs.push({
    id: 999,
    head_sha: history[554]!,
    head_branch: "next",
    status: "completed",
    conclusion: "success",
    run_number: 999,
    run_attempt: 1,
  });
  // More than 1,000 runs: branch-filtered GitHub searches would silently truncate this evidence.
  runs.unshift(
    ...Array.from({ length: 600 }, (_, i) => ({
      id: 1000 + i,
      head_sha: "unrelated",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      run_number: 1000 + i,
      run_attempt: 1,
    })),
  );
  let reads = 0;
  const smokeRuns: string[] = [];

  const adapters: PromotionAdapters = {
    releaseRevision() {
      throw new Error("Push runs do not need revision artifacts");
    },
    git(...args) {
      if (args[0] === "merge-base") return target;

      if (args[0] === "rev-list") return history.join("\n");

      if (args[0] === "diff-tree") return "feature.ts";

      if (args[0] === "rev-parse") {
        if (args[1] === "origin/dev") return history.at(-1)!;

        if (args[1] === "origin/next") return target;

        return target;
      }

      if (args.includes("--format=%ct")) return String((now - 2 * DAY) / 1000);

      if (args.includes("--format=%B")) return "feat: feature";
      throw new Error(`Unexpected git read: ${args.join(" ")}`);
    },
    api(path, method = "GET") {
      expect(method).toBe("GET");
      reads++;
      const url = new URL(`https://fixture.invalid/${path}`);
      const page = Number(url.searchParams.get("page"));

      if (path.includes("/workflows/")) {
        expect(url.searchParams.has("branch")).toBe(false);

        return { workflow_runs: runs.slice((page - 1) * 100, page * 100) };
      }

      smokeRuns.push(path);

      return {
        jobs: ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].map((platform) => ({
          name: `smoke (${platform}, fixture)`,
          conclusion: "success",
        })),
      };
    },
    pages(path) {
      reads++;

      if (path.includes("/pulls?"))
        return [
          {
            number: 68,
            merged_at: "2026-11-01",
            merge_commit_sha: history[0]!,
            base: { ref: "dev" },
            body: "",
            labels: [],
          },
        ];

      if (path.includes("/releases?") || path.includes("/issues?")) return [];
      throw new Error(`Unexpected GitHub read: ${path}`);
    },
  };

  const input = loadPromotion("fixture/canopy", "dev-next", DAY, adapters, now);
  expect(selectPromotion(input).sha).toBe(history[553]!);
  expect(selectPromotion(input).sha).toBe(history[553]!);
  expect(input.commits[0]!.prs[0]!.number).toBe(68);
  expect(smokeRuns).toHaveLength(1);
  expect(smokeRuns[0]).toContain("/runs/554/jobs?");
  expect(reads).toBeLessThan(20);
});

function recoveryFixture(path: "dev-next" | "next-main" = "next-main") {
  const sha = "a".repeat(40),
    target = "0".repeat(40),
    workflowSha = "b".repeat(40);

  const source = path === "dev-next" ? "dev" : "next";
  const tag = path === "dev-next" ? "v0.2.0-nightly.1" : "v0.2.0-beta.1";
  const now = Date.parse("2026-11-13T12:00:00Z");

  const runs = [
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
  ];

  const revision = { sha, branch: source };
  const artifact = { id: 12, name: "release-revision", expired: false };

  const jobs = [
    ...["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].map((platform) => ({
      name: `smoke (${platform}, fixture)`,
      conclusion: "success",
    })),
    ...["checks / Typecheck, tests, builds", "release", "publish-desktop"].map((name) => ({
      name,
      conclusion: "success",
    })),
  ];

  const releases: JsonValue[] = [
    {
      tag_name: tag,
      draft: false,
      prerelease: true,
      published_at: new Date(now - 5 * DAY).toISOString(),
      assets: [{ name: "manifest.json", updated_at: new Date(now - 5 * DAY).toISOString() }],
    },
  ];

  const reads: string[] = [];

  const adapters: PromotionAdapters = {
    git(...args) {
      if (args[0] === "merge-base") return target;

      if (args[0] === "rev-list") return args[3] === `${sha}..${workflowSha}` ? "" : sha;

      if (args[0] === "diff-tree") return "feature.ts";

      if (args[0] === "rev-parse") {
        if (args[1] === `origin/${source}` || args[1] === `${tag}^{commit}`) return sha;

        if (args[1] === "origin/dev") return workflowSha;

        return target;
      }

      if (args.includes("--format=%ct")) return String((now - 6 * DAY) / 1000);

      if (args.includes("--format=%B")) return "feat: recovered feature";
      throw new Error(`Unexpected git read: ${args.join(" ")}`);
    },
    api(path, method = "GET") {
      expect(method).toBe("GET");
      reads.push(path);

      if (path.includes("/workflows/")) return { workflow_runs: runs };

      if (path.includes("/335/artifacts?")) return { artifacts: [artifact] };

      if (path.includes("/335/jobs?")) return { jobs };
      throw new Error(`Unexpected GitHub read: ${path}`);
    },
    pages(path) {
      return path.includes("/releases?") ? releases : [];
    },
    releaseRevision(repo, id) {
      expect(repo).toBe("fixture/canopy");
      expect(id).toBe(12);

      if (revision.branch === "legacy") return;

      return revision;
    },
  };

  const load = () => loadPromotion("fixture/canopy", path, 3 * DAY, adapters, now);

  return { sha, target, workflowSha, runs, revision, artifact, jobs, releases, reads, load };
}

test("recovery publication gates use the artifact SHA for either promotion path", () => {
  for (const path of ["dev-next", "next-main"] as const) {
    const f = recoveryFixture(path);
    const input = f.load();
    expect(input.commits[0]!.green).toBe(true);
    expect(selectPromotion(input).sha).toBe(f.sha);
    expect(f.reads.some((path) => path.includes("/335/jobs?"))).toBe(true);
  }
});

test("a newer recovery wins over an older push's later cancelled attempt, regardless of API order", () => {
  for (const reverse of [false, true]) {
    const f = recoveryFixture();
    f.runs.push({
      id: 333,
      event: "push",
      head_branch: "next",
      head_sha: f.sha,
      status: "completed",
      conclusion: "cancelled",
      run_number: 333,
      run_attempt: 2,
    });

    if (reverse) f.runs.reverse();
    expect(selectPromotion(f.load()).sha).toBe(f.sha);
  }
});

test("dispatch artifacts cannot spoof another branch, SHA, ref, event or an expired/missing revision", () => {
  for (const scenario of ["branch", "sha", "short", "newline", "ref", "push", "expired", "missing", "legacy"]) {
    const f = recoveryFixture();

    if (scenario === "branch") f.revision.branch = "main";

    if (scenario === "legacy") f.revision.branch = "legacy";

    if (scenario === "sha") f.revision.sha = f.workflowSha;

    if (scenario === "short") f.revision.sha = f.sha.slice(0, 7);

    if (scenario === "newline") f.revision.sha += "\n";

    if (scenario === "ref") f.runs[0]!["head_branch"] = "feature";

    if (scenario === "push") f.runs[0]!["event"] = "push";

    if (scenario === "expired") f.artifact["expired"] = true;

    if (scenario === "missing") f.artifact["name"] = "unrelated";
    expect(selectPromotion(f.load()).sha, scenario).toBe(f.target);
  }
});

test("same-branch dispatches never use the workflow head SHA as fallback", () => {
  const f = recoveryFixture();
  f.runs[0]!["head_branch"] = "next";
  f.runs[0]!["head_sha"] = f.sha;
  f.revision.sha = f.workflowSha;
  expect(selectPromotion(f.load()).sha).toBe(f.target);
});

test("push and scheduled runs retain their exact-head gates without reading recovery artifacts", () => {
  for (const event of ["push", "schedule"]) {
    const f = recoveryFixture();
    f.runs[0]!["event"] = event;
    f.runs[0]!["head_branch"] = "next";
    f.runs[0]!["head_sha"] = f.sha;
    f.revision.branch = "main";
    expect(selectPromotion(f.load()).sha).toBe(f.sha);
    expect(f.reads.some((path) => path.includes("/artifacts?"))).toBe(false);
  }
});

test("green recovery needs public exact-SHA release, CI, all smoke targets and completed publication", () => {
  for (const scenario of ["no-release", "draft", "no-manifest", "ci", "smoke", "publication", "failure", "pending"]) {
    const f = recoveryFixture("dev-next");

    if (scenario === "no-release") f.releases.length = 0;

    if (scenario === "draft") f.releases[0] = { tag_name: "v0.2.0-nightly.1", draft: true, prerelease: true };

    if (scenario === "no-manifest")
      f.releases[0] = { tag_name: "v0.2.0-nightly.1", draft: false, prerelease: true, assets: [] };

    if (scenario === "ci") f.jobs[4]!["conclusion"] = "skipped";

    if (scenario === "smoke") f.jobs[0]!["conclusion"] = "skipped";

    if (scenario === "publication") f.jobs[6]!["conclusion"] = "skipped";

    if (scenario === "failure") f.runs[0]!["conclusion"] = "failure";

    if (scenario === "pending") f.runs[0]!["status"] = "in_progress";
    expect(selectPromotion(f.load()).sha, scenario).toBe(f.target);
  }
});

test("newer failed runs and newer failed attempts still block recovery readiness", () => {
  for (const scenario of ["new-run", "new-attempt"]) {
    const f = recoveryFixture();
    f.runs.push({
      ...f.runs[0]!,
      event: scenario === "new-run" ? "push" : "workflow_dispatch",
      head_branch: "next",
      head_sha: f.sha,
      conclusion: "failure",
      run_number: scenario === "new-run" ? 336 : 335,
      run_attempt: 2,
    });
    expect(selectPromotion(f.load()).sha).toBe(f.target);
  }
});
