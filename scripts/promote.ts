import { appendFileSync } from "node:fs";
import { api, git, pages, releaseRevision, repository } from "./release-github.ts";
import { loadPromotion, promotionBranches, promotionIssues, type PromotionAdapters } from "./promotion-data.ts";
import {
  DAY,
  DEV_NEXT_SOAK_MS,
  HOLD_CAP_DAYS,
  HOUR,
  promotionHoldCap,
  selectPromotion,
  type PromotionInput,
  type PromotionPlan,
} from "./promotion-policy.ts";
import { forecastPromotion, forecastPromotionWindow } from "./promotion-version.mjs";
import { finishPromotion, preparePromotion, promotionIssueSummary, resumePromotion } from "./promotion-journal.ts";
import { recoverPendingRelease } from "./promotion-recovery.ts";

export function burnInDays(value: string, policy = "Burn-in"): number {
  if (!/^\d+$/.test(value) || Number(value) > 365)
    throw new Error(`${policy} must be an integer between 0 and 365 days`);

  return Number(value);
}

export function promotionSummary(input: PromotionInput, plan: PromotionPlan, version?: string): string {
  const [source, target] = promotionBranches(input.path);
  const candidate = input.commits.find((commit) => commit.sha === plan.initial);

  const lines = [
    `### Promotion ${source} → ${target}`,
    `- Soak: ${input.soakMs / HOUR} h; evaluated at ${new Date(input.now).toISOString()}`,
    `- Target: ${input.target}`,
    ...(input.activeBeta ? [`- Active public beta: ${input.activeBeta.tag} (${input.activeBeta.sha})`] : []),
    ...(input.nightlyFloor ? [`- Minimum public nightly version: ${input.nightlyFloor}`] : []),
    `- Candidate C0: ${plan.initial}`,
    `- Final C: ${plan.sha}`,
    `- Expected version: ${version ?? "none (no release)"}; Release recomputes before publishing`,
    `- Decision: ${plan.reason}`,
    ...(candidate?.recoveryRun
      ? [
          `- Candidate recovery Release: ${candidate.recoveryRun}; exact-SHA gate: ${candidate.green ? "passed" : "failed"}`,
        ]
      : []),
    "",
    "Included commits:",
    ...plan.included.map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Held commits (each holds the entire suffix):",
    ...plan.holds.map((hold) => `- ${hold.sha}: ${hold.reason}; eligible since ${new Date(hold.since).toISOString()}`),
    "",
    "Expired automatic holds (skipped):",
    ...plan.expiredHolds.map(
      (hold) =>
        `- ${hold.sha}: hold expired after ${promotionHoldCap(input) / DAY} d: ${hold.reason}; eligible since ${new Date(hold.since).toISOString()}`,
    ),
    "",
    "Excluded suffix:",
    ...input.commits.slice(plan.included.length).map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Dev changes not yet on beta (follow-up signals only):",
    ...(input.pendingFixes ?? []).map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Promotion uses automated CI and Release results for the candidate commit.",
  ];

  return `${lines.join("\n")}\n`;
}

function attributionSummary(input: PromotionInput): string {
  const rows = [...input.commits, ...(input.pendingFixes ?? [])].flatMap((commit) =>
    commit.attributions.map(
      (item) => `- ${commit.sha} → ${item.sha}: ${item.file}:${item.lines.join(",")} (${item.kind})`,
    ),
  );

  return `\nLine attribution (fallback only; owners outside the candidate range cannot hold it):\n${rows.join("\n")}\n`;
}

function updateStarvationIssue(repo: string, path: string, summary: string, adapters: PromotionAdapters): void {
  const title = `Promotion stalled: ${path}`;
  const existing = promotionIssues(repo, adapters).find((issue) => issue.title === title);
  const body = promotionIssueSummary(repo, summary);

  if (!existing) adapters.api(`repos/${repo}/issues`, "POST", { title, body });
  else adapters.api(`repos/${repo}/issues/${existing.number}`, "PATCH", { body });
}

export interface PromotionOptions {
  dryRun: boolean;
  automatic?: boolean;
  paused: boolean;
  override: boolean;
  burnIn: number;
  /** Omitted by manual Promote, which retains uncapped relationship holds. */
  holdCapDays?: number;
}

export async function runPromotion(
  repo: string,
  path: PromotionInput["path"],
  options: PromotionOptions,
  adapters: PromotionAdapters,
  now = Date.now(),
) {
  const [source, target] = promotionBranches(path);

  const input = await loadPromotion(
    repo,
    path,
    path === "dev-next" ? DEV_NEXT_SOAK_MS : options.burnIn * DAY,
    adapters,
    now,
  );

  input.paused = options.paused && !options.override;
  input.holdCapMs = (options.holdCapDays ?? Infinity) * DAY;

  // Override bypasses timing and PR holds. The active beta line, CI, publication, blockers, follow-ups and FF still apply.
  if (options.override) {
    input.soakMs = 0;

    for (const commit of input.commits) commit.prs = commit.prs.map((pr) => ({ ...pr, hold: false }));
  }

  const plan = selectPromotion(input);
  const version = await forecastPromotion(input, plan, adapters.git);

  if (!version && plan.sha !== input.target) {
    plan.sha = input.target;
    plan.included = [];
    plan.reason = "No release-producing commits (or stable bootstrap missing)";
  }

  const next = options.dryRun ? await forecastPromotionWindow(input, plan, adapters.git) : undefined;

  const schedule = next
    ? `\nTime-only forecast (same CI/labels/history snapshot): eligible ${new Date(next.at).toISOString()}; next scheduled cycle ${nextPromotionCycle(next.at).toISOString()}; ${next.sha}; ${next.version}.\n`
    : "";

  const summary = promotionSummary(input, plan, version) + schedule;
  // Full blame evidence can exceed an issue's 65,536-character body limit. Keep it in the log/job summary;
  // the durable issue retains the decision, included/excluded commits and relevant hold reasons.
  const attribution = attributionSummary(input);
  console.log(summary);
  console.log(attribution);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryPath) appendFileSync(summaryPath, summary + attribution);

  if (options.dryRun) return { input, plan, version, next };

  if (resumePromotion(repo, input, adapters)) {
    if (summaryPath)
      appendFileSync(
        summaryPath,
        "Recovered promotion history after its push; Release is triggered by that push. No new promotion in this cycle.\n",
      );

    return { input, plan, version };
  }

  if (plan.starved) updateStarvationIssue(repo, path, summary, adapters);

  if (plan.sha === input.target) {
    if (options.automatic && !input.paused && input.blockers.length === 0 && input.pendingRelease?.branch === target) {
      adapters.git("fetch", "origin", "dev", "next", "main", "--tags");
      const pending = await loadPromotion(repo, path, input.soakMs, adapters, now, input);

      const recovered =
        pending.pendingRelease?.sha === input.pendingRelease.sha && recoverPendingRelease(repo, pending, adapters);

      if (recovered && summaryPath)
        appendFileSync(summaryPath, `Dispatched Release recovery for ${target} at ${pending.target}.\n`);
    }

    return { input, plan, version };
  }

  // Recheck refs and gates immediately before writing. No force, lease or backwards movement.
  adapters.git("fetch", "origin", "dev", "next", "main", "--tags");

  if (
    adapters.git("rev-parse", `origin/${target}`) !== input.target ||
    adapters.git("rev-parse", `origin/${source}`) !== input.commits.at(-1)?.sha
  )
    throw new Error("Branch moved during selection; retry next cycle");
  adapters.git("merge-base", "--is-ancestor", input.target, plan.sha);
  adapters.git("merge-base", "--is-ancestor", plan.sha, `origin/${source}`);
  const rechecked = await loadPromotion(repo, path, input.soakMs, adapters, now, input);
  rechecked.paused = input.paused;
  rechecked.holdCapMs = input.holdCapMs;

  if (options.override)
    for (const commit of rechecked.commits) commit.prs = commit.prs.map((pr) => ({ ...pr, hold: false }));

  const confirmed = selectPromotion(rechecked);

  if (
    confirmed.sha !== plan.sha ||
    rechecked.activeBeta?.tag !== input.activeBeta?.tag ||
    (await forecastPromotion(rechecked, confirmed, adapters.git)) !== version
  )
    throw new Error(`Promotion gates changed during selection: ${confirmed.reason}`);
  // Record intent before pushing; a failed history update must never cause a second Release dispatch.
  const issue = preparePromotion(repo, path, plan.sha, summary, adapters);
  const sourceRef = `refs/heads/${source}`;
  const targetRef = `refs/heads/${target}`;
  const heads = adapters.git("ls-remote", "--refs", "origin", sourceRef, targetRef).split("\n");

  if (!heads.includes(`${input.commits.at(-1)?.sha}\t${sourceRef}`) || !heads.includes(`${input.target}\t${targetRef}`))
    throw new Error("Branch moved while recording promotion intent; retry next cycle");
  adapters.git("push", "origin", `${plan.sha}:${targetRef}`);
  finishPromotion(repo, target, plan.sha, issue, adapters);
  console.log(`Promoted ${source} → ${target}: ${plan.sha}`);

  return { input, plan, version };
}

/** Hourly at :17 UTC in promotion-review.yml. */
function nextPromotionCycle(eligibleAt: number): Date {
  const offset = 17 * 60_000;

  return new Date(Math.ceil((eligibleAt - offset) / HOUR) * HOUR + offset);
}

if (import.meta.main) {
  const repo = repository();
  const automatic = process.argv.includes("--automatic");

  const paths: PromotionInput["path"][] = automatic
    ? ["next-main", "dev-next"]
    : [process.env["PROMOTION_PATH"] === "dev-next" ? "dev-next" : "next-main"];

  if (!automatic) promotionBranches(process.env["PROMOTION_PATH"] ?? "");
  git("fetch", "origin", "dev", "next", "main", "--tags");

  const options: PromotionOptions = {
    dryRun: process.argv.includes("--dry-run") || process.env["DRY_RUN"] === "true",
    automatic,
    paused: process.env["AUTO_PROMOTION"] === "off",
    override: !automatic && process.env["PROMOTION_OVERRIDE"] === "true",
    burnIn: burnInDays(process.env["BURN_IN_DAYS"] || "1"),
  };

  let failed = false;

  for (const path of paths) {
    try {
      const variable = path === "dev-next" ? "DEV_NEXT_HOLD_CAP_DAYS" : "NEXT_MAIN_HOLD_CAP_DAYS";

      await runPromotion(
        repo,
        path,
        {
          ...options,
          holdCapDays: automatic ? burnInDays(process.env[variable] || String(HOLD_CAP_DAYS), "Hold cap") : Infinity,
        },
        { git, api, pages, releaseRevision },
      );
    } catch (error) {
      failed = true;
      const message = `Promotion ${path} failed: ${error instanceof Error ? error.message : error}\n`;
      console.error(message);

      if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], message);
    }
  }

  if (failed) process.exitCode = 1;
}
