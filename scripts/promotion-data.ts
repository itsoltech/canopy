import { isJsonArray, isJsonObject, type JsonValue, type JsonObject } from "@canopy/domain/json";
import { promotionCommitLinks, type PromotionCommit, type PromotionInput } from "./promotion-policy.ts";
import { attributePromotionFix } from "./promotion-attribution.ts";

export interface PromotionAdapters {
  git: (...args: string[]) => string;
  api: (path: string, method?: string, body?: JsonValue) => JsonValue | undefined;
  pages: (path: string) => JsonValue[];
  releaseRevision: (repo: string, artifactId: number) => { sha: string; branch: string } | undefined;
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

function object(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new Error("Invalid GitHub object");

  return value;
}

function string(value: JsonValue | undefined): string {
  if (!isString(value)) throw new Error("Invalid GitHub string");

  return value;
}

function number(value: JsonValue | undefined): number {
  if (!isNumber(value)) throw new Error("Invalid GitHub number");

  return value;
}

function array(value: JsonValue | undefined): readonly JsonValue[] {
  if (!isJsonArray(value)) throw new Error("Invalid GitHub list");

  return value;
}

export function promotionBranches(path: string): ["dev" | "next", "next" | "main"] {
  if (path === "dev-next") return ["dev", "next"];

  if (path === "next-main") return ["next", "main"];
  throw new Error("Choose dev-next or next-main");
}

function mergedPrs(repo: string, source: string, adapters: PromotionAdapters) {
  const result = new Map<string, PromotionCommit["prs"]>();

  for (const base of new Set([source, "dev"])) {
    for (const value of adapters.pages(`repos/${repo}/pulls?state=closed&base=${base}&per_page=100`)) {
      const pr = object(value);

      // A commit can also appear in unmerged promotion/backmerge PRs; only its actual squash PR counts.
      if (!pr["merged_at"]) continue;
      const sha = string(pr["merge_commit_sha"]);

      if (object(pr["base"])["ref"] !== base) continue;
      const prs = result.get(sha) ?? [];

      prs.push({
        number: number(pr["number"]),
        body: pr["body"] === null ? "" : string(pr["body"]),
        hold: array(pr["labels"]).some((label) => object(label)["name"] === "promotion-hold"),
      });
      result.set(sha, prs);
    }
  }

  return result;
}

function publishedReleases(repo: string, source: string, adapters: PromotionAdapters) {
  const result = new Map<string, { tag: string; readyAt: number }>();
  const pattern = source === "dev" ? /^v\d+\.\d+\.\d+-nightly\.\d+$/ : /^v\d+\.\d+\.\d+-beta\.\d+$/;

  for (const value of adapters.pages(`repos/${repo}/releases?per_page=100`)) {
    const release = object(value);
    const tag = string(release["tag_name"]);

    if (!pattern.test(tag) || release["draft"] !== false || release["prerelease"] !== true) continue;

    const manifest = array(release["assets"])
      .map(object)
      .find((asset) => asset["name"] === "manifest.json");

    if (!manifest) continue;
    // Resolve the actual (possibly annotated) tag locally, never target_commitish (often just a branch name).
    const sha = adapters.git("rev-parse", `${tag}^{commit}`);
    const readyAt = Math.max(Date.parse(string(release["published_at"])), Date.parse(string(manifest["updated_at"])));

    if (!Number.isFinite(readyAt)) throw new Error(`Invalid publication time for ${tag}`);
    const existing = result.get(sha);

    if (!existing || readyAt > existing.readyAt) result.set(sha, { tag, readyAt });
  }

  return result;
}

function recoverySha(repo: string, source: string, run: JsonObject, adapters: PromotionAdapters): string | undefined {
  // Only trusted release branches can dispatch this workflow. The dispatch ref is not its build revision.
  if (!["dev", "next", "main"].includes(string(run["head_branch"]))) return;

  for (let page = 1; ; page++) {
    const response = object(
      adapters.api(`repos/${repo}/actions/runs/${number(run["id"])}/artifacts?per_page=100&page=${page}`),
    );

    const batch = array(response["artifacts"]);

    for (const value of batch) {
      const artifact = object(value);

      if (artifact["name"] !== "release-revision" || artifact["expired"] !== false) continue;
      const revision = adapters.releaseRevision(repo, number(artifact["id"]));

      if (revision?.branch === source && /^[0-9a-f]{40}$/.test(revision.sha) && revision.sha.length === 40)
        return revision.sha;
    }

    if (batch.length < 100) return;
  }
}

function latestRuns(repo: string, source: string, adapters: PromotionAdapters) {
  // Unlike issues/releases, the runs endpoint wraps each page in workflow_runs.
  const runs = new Map<string, JsonObject>();

  for (let page = 1; ; page++) {
    const response = object(
      adapters.api(
        // Filter locally: GitHub caps filtered run searches at 1,000 results, even with pagination.
        `repos/${repo}/actions/workflows/release.yml/runs?per_page=100&page=${page}`,
      ),
    );

    const batch = array(response["workflow_runs"]);

    for (const value of batch) {
      const run = object(value);

      const sha =
        run["event"] === "workflow_dispatch"
          ? recoverySha(repo, source, run, adapters)
          : run["head_branch"] === source
            ? string(run["head_sha"])
            : undefined;

      if (!sha) continue;
      const previous = runs.get(sha);

      // A later attempt of an older push must not supersede a newer recovery run.
      if (
        !previous ||
        number(run["run_number"]) > number(previous["run_number"]) ||
        (run["run_number"] === previous["run_number"] && number(run["run_attempt"]) > number(previous["run_attempt"]))
      )
        runs.set(sha, run);
    }

    if (batch.length < 100) break;
  }

  return runs;
}

function releaseJobs(repo: string, run: JsonObject, adapters: PromotionAdapters): JsonObject[] {
  const jobs: JsonObject[] = [];

  for (let page = 1; ; page++) {
    const response = object(
      adapters.api(`repos/${repo}/actions/runs/${number(run["id"])}/jobs?per_page=100&page=${page}`),
    );

    const batch = array(response["jobs"]);
    jobs.push(...batch.map(object));

    if (batch.length < 100) break;
  }

  return jobs;
}

function successfulSmoke(jobs: JsonObject[]): boolean {
  return ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].every((target) =>
    jobs.some((job) => string(job["name"]).startsWith(`smoke (${target},`) && job["conclusion"] === "success"),
  );
}

function recoveryPublished(repo: string, run: JsonObject, adapters: PromotionAdapters): boolean {
  const jobs = releaseJobs(repo, run, adapters);

  // A reserved tag/artifact alone is not publication. A no-release rerun can be green with skipped jobs.
  return (
    successfulSmoke(jobs) &&
    ["checks / Typecheck, tests, builds", "release", "publish-desktop"].every((name) =>
      jobs.some((job) => job["name"] === name && job["conclusion"] === "success"),
    )
  );
}

function readCommit(
  sha: string,
  prs: PromotionCommit["prs"],
  adapters: PromotionAdapters,
  previous?: PromotionCommit,
): PromotionCommit {
  const parent = previous?.parent ?? adapters.git("rev-parse", `${sha}^1`);

  const commit: PromotionCommit = {
    sha,
    parent,
    landedAt: previous?.landedAt ?? Number(adapters.git("show", "-s", "--format=%ct", sha)) * 1000,
    message: previous?.message ?? adapters.git("show", "-s", "--format=%B", sha),
    files:
      previous?.files ??
      adapters
        .git("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", parent, sha)
        .split("\n")
        .filter(Boolean),
    attributions: [],
    prs,
    green: false,
  };

  // Git objects are immutable, but PR bodies can change their explicit links between selection and push.
  commit.attributions =
    previous && JSON.stringify(promotionCommitLinks(previous)) === JSON.stringify(promotionCommitLinks(commit))
      ? previous.attributions
      : attributePromotionFix(commit, adapters.git);

  return commit;
}

function pendingDevFixes(
  sourceSha: string,
  adapters: PromotionAdapters,
  prs: Map<string, PromotionCommit["prs"]>,
  previous: Map<string, PromotionCommit>,
): PromotionCommit[] {
  const devSha = adapters.git("rev-parse", "origin/dev");
  adapters.git("merge-base", "--is-ancestor", sourceSha, devSha);

  return adapters
    .git("rev-list", "--first-parent", "--reverse", `${sourceSha}..${devSha}`)
    .split("\n")
    .filter(Boolean)
    .map((sha) => readCommit(sha, prs.get(sha) ?? [], adapters, previous.get(sha)));
}

export function loadPromotion(
  repo: string,
  path: PromotionInput["path"],
  soakMs: number,
  adapters: PromotionAdapters,
  now = Date.now(),
  targetOverride?: string,
  previousInput?: PromotionInput,
): PromotionInput {
  const [source, target] = promotionBranches(path);
  const sourceSha = adapters.git("rev-parse", `origin/${source}`);
  const targetSha = targetOverride ?? adapters.git("rev-parse", `origin/${target}`);
  adapters.git("merge-base", "--is-ancestor", targetSha, sourceSha);

  const history = adapters
    .git("rev-list", "--first-parent", "--reverse", `${targetSha}..${sourceSha}`)
    .split("\n")
    .filter(Boolean);

  const releases = history.length
    ? publishedReleases(repo, source, adapters)
    : new Map<string, { tag: string; readyAt: number }>();

  const prs = history.length ? mergedPrs(repo, source, adapters) : new Map<string, PromotionCommit["prs"]>();
  const runs = history.length ? latestRuns(repo, source, adapters) : new Map<string, JsonObject>();

  const previous = new Map(
    [...(previousInput?.commits ?? []), ...(previousInput?.pendingFixes ?? [])].map((commit) => [commit.sha, commit]),
  );

  const commits: PromotionCommit[] = [];
  // A stable hotfix can be target via a merge's second parent after Back-merge.
  // Older first-parent commits are still dependencies, but cannot themselves be promoted over that hotfix.
  const minimumIndex = history.findIndex((sha) => adapters.git("merge-base", targetSha, sha) === targetSha);

  for (const sha of history) {
    const latest = runs.get(sha);
    const release = releases.get(sha);
    const commit = readCommit(sha, prs.get(sha) ?? [], adapters, previous.get(sha));
    let green: boolean | undefined;
    // The policy reads this only for a possible candidate; excluded untagged commits need no jobs API calls.
    Object.defineProperty(commit, "green", {
      enumerable: true,
      get: () =>
        (green ??=
          latest?.["status"] === "completed" &&
          latest["conclusion"] === "success" &&
          (latest["event"] === "workflow_dispatch"
            ? !!release && recoveryPublished(repo, latest, adapters)
            : !!release || successfulSmoke(releaseJobs(repo, latest, adapters)))),
    });

    if (release) commit.release = release;
    commits.push(commit);
  }

  const blockers = adapters
    .pages(`repos/${repo}/issues?state=open&labels=release-blocker&per_page=100`)
    .map(object)
    .filter((issue) => !issue["pull_request"])
    .map((issue) => number(issue["number"]));

  const input: PromotionInput = {
    path,
    target: targetSha,
    commits,
    now,
    soakMs,
    paused: false,
    blockers,
    minimumIndex: Math.max(0, minimumIndex),
  };

  if (path === "next-main" && commits.length) input.pendingFixes = pendingDevFixes(sourceSha, adapters, prs, previous);

  return input;
}

export function promotionIssues(repo: string, adapters: PromotionAdapters) {
  return adapters
    .pages(`repos/${repo}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100`)
    .map(object)
    .filter((issue) => !issue["pull_request"])
    .map((issue) => ({
      number: number(issue["number"]),
      title: string(issue["title"]),
      body: issue["body"] ? string(issue["body"]) : "",
    }));
}

export function createdIssueNumber(value: JsonValue | undefined): number {
  return number(object(value)["number"]);
}
