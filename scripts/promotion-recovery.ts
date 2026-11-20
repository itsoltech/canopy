import {
  latestRuns,
  promotionBranches,
  promotionIssues,
  releaseJobs,
  type PromotionAdapters,
} from "./promotion-data.ts";
import { HOUR, type PromotionInput } from "./promotion-policy.ts";
import { closedBetaCores, latestBetaTag } from "./release-version-policy.mjs";

type PendingRelease = NonNullable<PromotionInput["pendingRelease"]>;

function retiredBeta(pending: PendingRelease, publicTags: string[], git: PromotionAdapters["git"]) {
  const tags = git("tag", "--list", "v*").split("\n");
  const mainTags = git("tag", "--points-at", "origin/main").split("\n");
  const closed = closedBetaCores(tags, publicTags, mainTags);
  const core = (tag: string) => tag.slice(1).split("-")[0]!;

  const retiredReservation = git("tag", "--points-at", pending.sha, "--list", "v*-beta.*")
    .split("\n")
    .some((tag) => closed.has(core(tag)) && !publicTags.includes(tag));

  const lastBeta = latestBetaTag(publicTags);

  return { retiredReservation, closedSeries: !!lastBeta && closed.has(core(lastBeta)) };
}

function recordedPush(body: string, pending: PendingRelease, now: number): boolean {
  const receipt = `Pushed ${pending.sha} to ${pending.branch}; Release is triggered by the push`;
  const evaluatedAt = Date.parse(body.match(/evaluated at ([^\n]+)/)?.[1] ?? "");

  // Allow time for the original push run to appear in GitHub Actions.
  return body.includes(receipt) && evaluatedAt <= now - HOUR;
}

function failedAfterPlanning(jobs: ReturnType<typeof releaseJobs>, retiredReservation: boolean): boolean {
  const succeeded = jobs.some(
    (job) => job["name"] === "checks / Typecheck, tests, builds" && job["conclusion"] === "success",
  );

  const versionOrPublication = ["release", "publish-server", "publish-desktop"];

  return jobs.some(
    (job) =>
      job["conclusion"] === "failure" &&
      ((succeeded && versionOrPublication.includes(String(job["name"]))) ||
        (retiredReservation && job["name"] === "plan")),
  );
}

/** Retry a confirmed promotion push with no run or recover a superseded beta reservation once per SHA. */
export function recoverPendingRelease(repo: string, input: PromotionInput, adapters: PromotionAdapters): boolean {
  const pending = input.pendingRelease;
  const [, target] = promotionBranches(input.path);

  if (!pending || pending.branch !== target || input.paused || input.blockers.length) return false;
  const { branch, sha } = pending;
  const issues = promotionIssues(repo, adapters);
  const title = `Release recovery: ${branch}`;
  const existing = issues.find((issue) => issue.title === title);
  const marker = `<!-- canopy-release-recovery: ${sha} -->`;

  if (existing?.body.includes(marker)) return false;
  const promotion = issues.find((issue) => issue.title === `Promotion history: ${input.path}`);
  const missingTrigger = !!promotion && recordedPush(promotion.body, pending, input.now);

  const retired = branch === "next" ? retiredBeta(pending, input.publicReleaseTags ?? [], adapters.git) : undefined;

  if (!missingTrigger && !retired?.closedSeries && !retired?.retiredReservation) return false;
  const { runs, busy } = latestRuns(repo, branch, adapters);

  if (busy) return false;
  const latest = runs.get(sha);
  const failed = latest?.["conclusion"] === "failure";

  const staleBeta =
    retired &&
    (retired.retiredReservation || retired.closedSeries) &&
    (failed
      ? failedAfterPlanning(releaseJobs(repo, latest, adapters), retired.retiredReservation)
      : retired.retiredReservation &&
        (!latest || latest["conclusion"] === "cancelled" || latest["conclusion"] === "success"));

  if ((!missingTrigger || latest) && !staleBeta) return false;
  const ref = `refs/heads/${branch}`;

  if (adapters.git("ls-remote", "--refs", "origin", ref).split("\t")[0] !== sha) return false;
  const reason = staleBeta ? "The previous beta series is closed" : "The promotion push has no Release run";
  const body = `Attempted a Release dispatch from dev for ${branch} at ${sha}. ${reason}.\n\n${marker}\n`;

  // Write intent before dispatch so a lost API response cannot produce an hourly retry loop.
  if (existing) adapters.api(`repos/${repo}/issues/${existing.number}`, "PATCH", { body });
  else adapters.api(`repos/${repo}/issues`, "POST", { title, body });
  adapters.api(`repos/${repo}/actions/workflows/release.yml/dispatches`, "POST", {
    ref: "dev",
    inputs: { release_branch: branch, expected_sha: sha },
  });
  console.log(`Dispatched Release recovery for ${branch} at ${sha}. ${reason}.`);

  return true;
}
