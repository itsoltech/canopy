import { appendFileSync } from "node:fs";
import { api, git, pages, repository } from "./release-github.ts";
import { loadPromotion, promotionBranches, promotionIssues, type PromotionAdapters } from "./promotion-data.ts";
import { DAY, selectPromotion, type PromotionInput, type PromotionPlan } from "./promotion-policy.ts";
import { forecastPromotion } from "./promotion-version.mjs";
import { finishPromotion, preparePromotion, resumePromotion } from "./promotion-journal.ts";

export function burnInDays(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 365) throw new Error("Burn-in must be an integer between 0 and 365 days");

  return Number(value);
}

export function promotionSummary(input: PromotionInput, plan: PromotionPlan, version?: string): string {
  const [source, target] = promotionBranches(input.path);

  const lines = [
    `### Promotion ${source} → ${target}`,
    `- Soak: ${input.soakMs / 3_600_000} h; evaluated at ${new Date(input.now).toISOString()}`,
    `- Target: ${input.target}`,
    `- Candidate C0: ${plan.initial}`,
    `- Final C: ${plan.sha}`,
    `- Expected version: ${version ?? "none (no release)"}; Release recomputes before publishing`,
    `- Decision: ${plan.reason}`,
    "",
    "Included commits:",
    ...plan.included.map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Held commits (each holds the entire suffix):",
    ...plan.holds.map((hold) => `- ${hold.sha}: ${hold.reason}; eligible since ${new Date(hold.since).toISOString()}`),
    "",
    "Excluded suffix:",
    ...input.commits.slice(plan.included.length).map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Dev changes not yet on beta (follow-up signals only):",
    ...(input.pendingFixes ?? []).map((commit) => `- ${commit.sha} ${commit.message.split("\n")[0]}`),
    "",
    "Smoke evidence: successful Release on the exact commit (CI, binary startup on all server targets, publication). No human live/update confirmation.",
  ];

  return `${lines.join("\n")}\n`;
}

function updateStarvationIssue(repo: string, path: string, body: string, adapters: PromotionAdapters): void {
  const title = `Promotion stalled: ${path}`;
  const existing = promotionIssues(repo, adapters).find((issue) => issue.title === title);

  if (!existing) adapters.api(`repos/${repo}/issues`, "POST", { title, body });
  else adapters.api(`repos/${repo}/issues/${existing.number}`, "PATCH", { body });
}

export interface PromotionOptions {
  dryRun: boolean;
  paused: boolean;
  override: boolean;
  burnIn: number;
}

export async function runPromotion(
  repo: string,
  path: PromotionInput["path"],
  options: PromotionOptions,
  adapters: PromotionAdapters,
  now = Date.now(),
) {
  const [source, target] = promotionBranches(path);
  const input = loadPromotion(repo, path, path === "dev-next" ? DAY : options.burnIn * DAY, adapters, now);
  input.paused = options.paused && !options.override;

  // Override bypasses timing and PR holds; CI, publication, blockers, follow-ups and FF remain mandatory.
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

  const summary = promotionSummary(input, plan, version);
  console.log(summary);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryPath) appendFileSync(summaryPath, summary);

  if (options.dryRun) return { input, plan, version };

  if (resumePromotion(repo, input, adapters, options.override)) {
    if (summaryPath)
      appendFileSync(
        summaryPath,
        "Handled pending Release (re-dispatched or held after rechecking its original range); no new promotion in this cycle.\n",
      );

    return { input, plan, version };
  }

  if (plan.starved) updateStarvationIssue(repo, path, summary, adapters);

  if (plan.sha === input.target) return { input, plan, version };

  // Recheck refs and gates immediately before writing. No force, lease or backwards movement.
  adapters.git("fetch", "origin", "dev", source, target);

  if (
    adapters.git("rev-parse", `origin/${target}`) !== input.target ||
    adapters.git("rev-parse", `origin/${source}`) !== input.commits.at(-1)?.sha
  )
    throw new Error("Branch moved during selection; retry next cycle");
  adapters.git("merge-base", "--is-ancestor", input.target, plan.sha);
  adapters.git("merge-base", "--is-ancestor", plan.sha, `origin/${source}`);
  const rechecked = loadPromotion(repo, path, input.soakMs, adapters, now);
  rechecked.paused = input.paused;

  if (options.override)
    for (const commit of rechecked.commits) commit.prs = commit.prs.map((pr) => ({ ...pr, hold: false }));

  if (selectPromotion(rechecked).sha !== plan.sha) throw new Error("Promotion gates changed during selection");
  // Durable intent recovers a successful push followed by a failed dispatch on the next scheduled cycle.
  const issue = preparePromotion(repo, path, plan.sha, summary, adapters);
  adapters.git("push", "origin", `${plan.sha}:refs/heads/${target}`);
  finishPromotion(repo, target, plan.sha, issue, adapters);
  console.log(`Promoted ${source} → ${target}: ${plan.sha}`);

  return { input, plan, version };
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
    paused: process.env["AUTO_PROMOTION"] === "off",
    override: !automatic && process.env["PROMOTION_OVERRIDE"] === "true",
    burnIn: burnInDays(process.env["BURN_IN_DAYS"] || "3"),
  };

  let failed = false;

  for (const path of paths) {
    try {
      await runPromotion(repo, path, options, { git, api, pages });
    } catch (error) {
      failed = true;
      const message = `Promotion ${path} failed: ${error instanceof Error ? error.message : error}\n`;
      console.error(message);

      if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], message);
    }
  }

  if (failed) process.exitCode = 1;
}
