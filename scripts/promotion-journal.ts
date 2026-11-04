import {
  createdIssueNumber,
  loadPromotion,
  promotionBranches,
  promotionIssues,
  type PromotionAdapters,
} from "./promotion-data.ts";
import { selectPromotion, type PromotionInput } from "./promotion-policy.ts";

interface JournalEntry {
  number: number;
  body: string;
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
  const body = `${summary}\n<!-- canopy-promotion-pending: ${sha} -->\n`;

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
  adapters.api(`repos/${repo}/actions/workflows/release.yml/dispatches`, "POST", {
    ref: target,
    inputs: { expected_sha: sha },
  });
  const status = `Release dispatched on ${target} with expected_sha=${sha}.\nPublication result: https://github.com/${repo}/actions/workflows/release.yml`;
  adapters.api(`repos/${repo}/issues/${issue.number}`, "PATCH", {
    body: issue.body.replace(/<!-- canopy-promotion-pending: [a-f0-9]{40} -->/, status),
  });
}

/** Recover a push followed by a failed dispatch, even when target == source and selection is now a no-op. */
export function resumePromotion(
  repo: string,
  input: PromotionInput,
  adapters: PromotionAdapters,
  override: boolean,
): boolean {
  if (input.paused || input.blockers.length) return false;
  const existing = promotionIssues(repo, adapters).find((issue) => issue.title === `Promotion history: ${input.path}`);
  const pending = existing?.body.match(/<!-- canopy-promotion-pending: ([a-f0-9]{40}) -->/);

  if (!existing || !pending || pending[1] !== input.target) return false;
  const previousTarget = existing.body.match(/^- Target: ([a-f0-9]{40})$/m)?.[1];

  if (!previousTarget) throw new Error("Pending promotion journal has no previous target");
  // A new fix/hold may have landed after the push. Re-evaluate the original range before releasing it.
  const rechecked = loadPromotion(repo, input.path, input.soakMs, adapters, input.now, previousTarget);

  if (override) for (const commit of rechecked.commits) commit.prs = commit.prs.map((pr) => ({ ...pr, hold: false }));
  const selected = selectPromotion(rechecked).sha;

  if (selected !== input.target) {
    // A newer complete safe prefix can replace this pending publication in the regular path.
    if (adapters.git("merge-base", input.target, selected) === input.target) return false;
    console.log(`Pending Release ${input.target} is now held; waiting for its fixes/gates`);

    return true;
  }

  const [, target] = promotionBranches(input.path);
  finishPromotion(repo, target, input.target, existing, adapters);
  console.log(`Recovered Release dispatch for ${target}: ${input.target}`);

  return true;
}
