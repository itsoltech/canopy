import { api, dispatchRelease, git, pages, repository } from "./release-github.ts";

export interface PromotionRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; updated_at: string }[];
}

export function burnInDays(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 365) throw new Error("Burn-in must be an integer between 0 and 365 days");

  return Number(value);
}

export function verifyBetaAge(release: PromotionRelease, days: number, now = Date.now()): void {
  const manifest = release.assets.find((asset) => asset.name === "manifest.json");

  if (!manifest) throw new Error("Release assets are not ready");
  const since = Math.max(Date.parse(release.published_at), Date.parse(manifest.updated_at));

  if (!Number.isFinite(since) || now - since < days * 86_400_000)
    throw new Error(`Beta needs at least ${days} days of burn-in after assets are ready`);
}

function sourceAndTarget(path: string): ["dev" | "next", "next" | "main"] {
  if (path === "dev-next") return ["dev", "next"];

  if (path === "next-main") return ["next", "main"];
  throw new Error("Choose dev-next or next-main");
}

export function candidate(
  repo: string,
  path: string,
  days: number,
): { source: string; target: string; sha: string; release: PromotionRelease } {
  const [source, target] = sourceAndTarget(path);
  git("fetch", "origin", source, target, "--tags", "--force");
  const sha = git("rev-parse", `origin/${source}`);
  const targetSha = git("rev-parse", `origin/${target}`);

  if (sha === targetSha) throw new Error("Target already contains the source head");
  git("merge-base", "--is-ancestor", targetSha, sha);
  const prefix = source === "dev" ? "nightly" : "beta";

  const tag = git("tag", "--points-at", sha, "--list", "v*")
    .split("\n")
    .find((name) => new RegExp(`^v\\d+\\.\\d+\\.\\d+-${prefix}\\.\\d+$`).test(name));

  if (!tag) throw new Error(`Source HEAD must be a published ${prefix} tag; select that commit before promotion`);

  const runs = api<{
    workflow_runs: { head_sha: string; head_branch: string; status: string; conclusion: string | null }[];
  }>(`repos/${repo}/actions/workflows/release.yml/runs?branch=${source}&head_sha=${sha}&per_page=100`).workflow_runs;

  const run = runs.find((item) => item.head_sha === sha && item.head_branch === source);

  if (!run || run.status !== "completed" || run.conclusion !== "success")
    throw new Error("The latest Release run (including CI) on source HEAD must be green");

  const blockers = pages<{ pull_request?: unknown }>(
    `repos/${repo}/issues?state=open&labels=release-blocker&per_page=100`,
  );

  if (blockers.some((issue) => !issue.pull_request)) throw new Error("Open release-blocker issues prevent promotion");
  const release = api<PromotionRelease>(`repos/${repo}/releases/tags/${tag}`);

  if (release.draft || !release.prerelease || !release.assets.some((asset) => asset.name === "manifest.json"))
    throw new Error("Source prerelease must have a complete manifest");

  if (target === "main") verifyBetaAge(release, days);

  return { source, target, sha, release };
}

function promote(repo: string, path: string, days: number, automatic = false): void {
  const selected = candidate(repo, path, days);

  if (automatic) {
    if (selected.source !== "dev" || process.env["NIGHTLY_SMOKE_SHA"] !== selected.sha)
      throw new Error("Automatic beta promotion needs NIGHTLY_SMOKE_SHA equal to the source head");
  } else {
    if (process.env["LIVE_SMOKE"] !== "true") throw new Error("Confirm live smoke before promotion");

    if (selected.target === "main" && process.env["UPDATE_SMOKE"] !== "true")
      throw new Error("Confirm updates/self-update smoke before stable promotion");
  }

  // No force: a concurrent target change fails safely. Source is pinned to the validated SHA.
  git("push", "origin", `${selected.sha}:refs/heads/${selected.target}`);
  dispatchRelease(repo, selected.target, selected.sha);
  console.log(`Promoted ${selected.source} → ${selected.target}: ${selected.sha}`);
}

function recommend(repo: string, days: number): void {
  let selected: ReturnType<typeof candidate>;

  try {
    selected = candidate(repo, "next-main", days);
  } catch (error) {
    console.log(`No stable promotion candidate: ${error instanceof Error ? error.message : error}`);

    return;
  }

  const title = `Promote next → main (beta ${selected.release.tag_name.slice(1)})`;
  const body = `Beta: ${selected.release.tag_name}\nSource: ${selected.sha}\n\n- [x] Target is an ancestor of source\n- [x] Release CI on source HEAD is green\n- [x] Beta assets available for at least ${days} days\n- [x] No open release-blocker issues\n- [ ] Live smoke green\n- [ ] Updates/self-update smoke green\n- [ ] Maintainer runs [Promote](https://github.com/${repo}/actions/workflows/promote.yml) with next-main and both smoke confirmations\n\nThe workflow rechecks all conditions. This issue never promotes stable automatically.`;

  const issues = pages<{ number: number; title: string; pull_request?: unknown }>(
    `repos/${repo}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100`,
  );

  const existing = issues.find((issue) => !issue.pull_request && issue.title.startsWith("Promote next → main (beta "));

  if (existing) api(`repos/${repo}/issues/${existing.number}`, "PATCH", { title, body });
  else api(`repos/${repo}/issues`, "POST", { title, body });
}

if (import.meta.main) {
  const repo = repository();
  const days = burnInDays(process.env["BURN_IN_DAYS"] || "3");

  if (process.argv.includes("--recommend")) {
    recommend(repo, days);

    if (process.env["AUTO_PROMOTE_DEV_TO_NEXT"] === "true") {
      try {
        promote(repo, "dev-next", days, true);
      } catch (error) {
        console.log(`No automatic beta promotion: ${error instanceof Error ? error.message : error}`);
      }
    }
  } else promote(repo, process.env["PROMOTION_PATH"] ?? "", days);
}
