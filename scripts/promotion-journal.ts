import { createdIssueNumber, promotionBranches, promotionIssues, type PromotionAdapters } from "./promotion-data.ts";
import type { PromotionInput } from "./promotion-policy.ts";

interface JournalEntry {
  number: number;
  body: string;
}

/** Leave room within GitHub's 65,536-character limit for the pending marker and the push receipt. */
export function promotionIssueSummary(repo: string, summary: string): string {
  const limit = 64_000;

  if (summary.length <= limit) return summary;
  const run = process.env["GITHUB_RUN_ID"];

  const note = run
    ? `\n\nFull promotion plan: https://github.com/${repo}/actions/runs/${run}\n`
    : "\n\nSee the promotion log for the full plan.\n";

  const end = summary.lastIndexOf("\n", limit - note.length);

  return summary.slice(0, Math.max(0, end)) + note;
}

export function preparePromotion(
  repo: string,
  path: string,
  sha: string,
  summary: string,
  adapters: PromotionAdapters,
) {
  const title = `Promotion history: ${path}`;
  const existing = promotionIssues(repo, adapters).find((issue) => issue.title === title);
  const body = `${promotionIssueSummary(repo, summary)}\n<!-- canopy-promotion-pending: ${sha} -->\n`;

  if (!existing)
    return { number: createdIssueNumber(adapters.api(`repos/${repo}/issues`, "POST", { title, body })), body };
  // Preserve the previous plan before replacing the current status, including any failed attempt.
  adapters.api(`repos/${repo}/issues/${existing.number}/comments`, "POST", { body: existing.body });
  adapters.api(`repos/${repo}/issues/${existing.number}`, "PATCH", { body });

  return { number: existing.number, body };
}

export function finishPromotion(
  repo: string,
  target: string,
  sha: string,
  issue: JournalEntry,
  adapters: PromotionAdapters,
): void {
  const status = `Pushed ${sha} to ${target}; Release is triggered by the push, with expected_sha=${sha}.\nPublication result: https://github.com/${repo}/actions/workflows/release.yml`;
  const summary = issue.body.replace(/<!-- canopy-promotion-pending: [a-f0-9]{40} -->/, "").trimEnd();
  adapters.api(`repos/${repo}/issues/${issue.number}`, "PATCH", {
    body: `${promotionIssueSummary(repo, summary)}\n\n${status}\n`,
  });
}

/** Repair history after a successful push; never dispatch another Release, including for older journals. */
export function resumePromotion(repo: string, input: PromotionInput, adapters: PromotionAdapters): boolean {
  const existing = promotionIssues(repo, adapters).find((issue) => issue.title === `Promotion history: ${input.path}`);
  const pending = existing?.body.match(/<!-- canopy-promotion-pending: ([a-f0-9]{40}) -->/);

  if (!existing || !pending || pending[1] !== input.target) return false;
  const [, target] = promotionBranches(input.path);
  finishPromotion(repo, target, input.target, existing, adapters);
  console.log(`Recovered promotion history for ${target}: ${input.target}; no Release dispatch`);

  return true;
}
