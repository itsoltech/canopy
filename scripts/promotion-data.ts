import { isJsonArray, isJsonObject, type JsonValue, type JsonObject } from "@canopy/domain/json";
import type { PromotionCommit, PromotionInput } from "./promotion-policy.ts";
import { attributePromotionFix } from "./promotion-attribution.ts";

export interface PromotionAdapters {
  git: (...args: string[]) => string;
  api: (path: string, method?: string, body?: JsonValue) => JsonValue | undefined;
  pages: (path: string) => JsonValue[];
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

function prsForCommit(repo: string, sha: string, source: string, adapters: PromotionAdapters): PromotionCommit["prs"] {
  return adapters.pages(`repos/${repo}/commits/${sha}/pulls?per_page=100`).flatMap((value) => {
    const pr = object(value);

    // A commit can also appear in unmerged promotion/backmerge PRs; only its actual squash PR counts.
    if (!pr["merged_at"] || pr["merge_commit_sha"] !== sha) return [];
    const base = string(object(pr["base"])["ref"]);

    if (base !== source && base !== "dev") return [];

    return [
      {
        number: number(pr["number"]),
        body: pr["body"] === null ? "" : string(pr["body"]),
        hold: array(pr["labels"]).some((label) => object(label)["name"] === "promotion-hold"),
      },
    ];
  });
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

function latestRun(repo: string, source: string, sha: string, adapters: PromotionAdapters) {
  // Unlike issues/releases, the runs endpoint wraps each page in workflow_runs.
  const runs: JsonObject[] = [];

  for (let page = 1; ; page++) {
    const response = object(
      adapters.api(
        `repos/${repo}/actions/workflows/release.yml/runs?branch=${source}&head_sha=${sha}&per_page=100&page=${page}`,
      ),
    );

    const batch = array(response["workflow_runs"]);
    runs.push(...batch.map(object));

    if (batch.length < 100) break;
  }

  return runs
    .filter((run) => run["head_sha"] === sha && run["head_branch"] === source)
    .sort(
      (a, b) =>
        number(b["run_number"]) - number(a["run_number"]) || number(b["run_attempt"]) - number(a["run_attempt"]),
    )[0];
}

function untaggedSmoke(repo: string, run: JsonObject, adapters: PromotionAdapters): boolean {
  const jobs: JsonObject[] = [];

  for (let page = 1; ; page++) {
    const response = object(
      adapters.api(`repos/${repo}/actions/runs/${number(run["id"])}/jobs?per_page=100&page=${page}`),
    );

    const batch = array(response["jobs"]);
    jobs.push(...batch.map(object));

    if (batch.length < 100) break;
  }

  return ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].every((target) =>
    jobs.some((job) => string(job["name"]).startsWith(`smoke (${target},`) && job["conclusion"] === "success"),
  );
}

function readCommit(repo: string, source: string, sha: string, adapters: PromotionAdapters): PromotionCommit {
  const parent = adapters.git("rev-parse", `${sha}^1`);

  const commit: PromotionCommit = {
    sha,
    parent,
    landedAt: Number(adapters.git("show", "-s", "--format=%ct", sha)) * 1000,
    message: adapters.git("show", "-s", "--format=%B", sha),
    files: adapters
      .git("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", parent, sha)
      .split("\n")
      .filter(Boolean),
    attributions: [],
    prs: prsForCommit(repo, sha, source, adapters),
    green: false,
  };

  commit.attributions = attributePromotionFix(commit, adapters.git);

  return commit;
}

function pendingDevFixes(repo: string, sourceSha: string, adapters: PromotionAdapters): PromotionCommit[] {
  const devSha = adapters.git("rev-parse", "origin/dev");
  adapters.git("merge-base", "--is-ancestor", sourceSha, devSha);

  return adapters
    .git("rev-list", "--first-parent", "--reverse", `${sourceSha}..${devSha}`)
    .split("\n")
    .filter(Boolean)
    .map((sha) => readCommit(repo, "dev", sha, adapters));
}

export function loadPromotion(
  repo: string,
  path: PromotionInput["path"],
  soakMs: number,
  adapters: PromotionAdapters,
  now = Date.now(),
  targetOverride?: string,
): PromotionInput {
  const [source, target] = promotionBranches(path);
  const sourceSha = adapters.git("rev-parse", `origin/${source}`);
  const targetSha = targetOverride ?? adapters.git("rev-parse", `origin/${target}`);
  adapters.git("merge-base", "--is-ancestor", targetSha, sourceSha);

  const history = adapters
    .git("rev-list", "--first-parent", "--reverse", `${targetSha}..${sourceSha}`)
    .split("\n")
    .filter(Boolean);

  const releases = publishedReleases(repo, source, adapters);
  const commits: PromotionCommit[] = [];
  // A stable hotfix can be target via a merge's second parent after Back-merge.
  // Older first-parent commits are still dependencies, but cannot themselves be promoted over that hotfix.
  const minimumIndex = history.findIndex((sha) => adapters.git("merge-base", targetSha, sha) === targetSha);

  for (const sha of history) {
    const latest = latestRun(repo, source, sha, adapters);
    const release = releases.get(sha);
    const commit = readCommit(repo, source, sha, adapters);
    commit.green =
      latest?.["status"] === "completed" &&
      latest["conclusion"] === "success" &&
      (!!release || untaggedSmoke(repo, latest, adapters));

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

  if (path === "next-main" && commits.length) input.pendingFixes = pendingDevFixes(repo, sourceSha, adapters);

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
