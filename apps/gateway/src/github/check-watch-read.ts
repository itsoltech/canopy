import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import type { WatchedCheck } from "@canopy/domain";
import { checks } from "./checks.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { readScope } from "./read-scope.ts";

/** Pages read per poll: 50 checks each (checks.ts), so up to 300 checks of one commit. */
const MAX_PAGES = 6;

/**
 * Every check of the snapshot's head, through the checks page reads the panel uses (same cache, budgets and
 * validation that the page still belongs to that head). Agent CI watches only (core/pr-check-watches.ts).
 */
export async function readWatchCheckPages(
  prs: GitHubPullRequests,
  pullRequestId: string,
  snapshot: github.PullRequestSnapshot,
  refresh = false,
): Promise<{ checks: WatchedCheck[]; complete: boolean }> {
  const found: WatchedCheck[] = [];
  let cursor = "";
  let complete = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    const request = create(github.PullRequestPageRequestSchema, {
      pullRequestId,
      headSha: snapshot.summary?.headSha ?? "",
      baseSha: snapshot.baseSha,
      cursor,
      refresh,
    });

    const result = await checks(await readScope(prs, request, "checks", true, snapshot));

    for (const check of result.checks)
      found.push({
        key: check.nodeId || `${check.provider}:${check.name}`,
        name: check.name,
        state: check.state,
        provider: check.provider,
        url: check.url,
        runId: check.runId,
      });

    cursor = result.page?.nextCursor ?? "";
    complete &&= result.page?.completeness === "complete" && !result.page.stale;

    if (!cursor) break;
  }

  return { checks: found, complete: complete && !cursor };
}

export async function readWatchedChecks(
  prs: GitHubPullRequests,
  pullRequestId: string,
  snapshot: github.PullRequestSnapshot,
): Promise<WatchedCheck[]> {
  return (await readWatchCheckPages(prs, pullRequestId, snapshot)).checks;
}

/** What watch_pr_checks may name: a linked pull request's id, repository and number. */
export interface LinkedPullRequest {
  readonly id: string;
  readonly repository: string;
  readonly number: number;
}

const URL_FORM = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,9})\/?(?:[#?].*)?$/i;
const SHORT_FORM = /^([\w.-]+\/[\w.-]+)?#?([1-9]\d{0,9})$/;

/** The linked pull request `text` names (URL, owner/repo#n, #n or n), or why none does. */
export function matchLinkedPullRequest(
  text: string,
  linked: readonly LinkedPullRequest[],
): { pr: LinkedPullRequest } | { problem: string } {
  const value = text.trim();
  const parts = URL_FORM.exec(value) ?? SHORT_FORM.exec(value);

  const listed = linked.length
    ? `Pull requests linked to this thread: ${linked.map((p) => `${p.repository}#${p.number}`).join(", ")}.`
    : "No pull request is linked to this thread yet.";

  const hint =
    "One opened with gh pr create is linked a few seconds after its output. If it is missing, use link_pull_request with its URL or owner/repo#123, then retry watch_pr_checks.";

  if (!parts) return { problem: `Name the pull request by its URL, owner/repo#123 or #123. ${listed}` };
  const repository = parts[1]?.toLowerCase();
  const number = Number(parts[2]);

  const matches = linked.filter(
    (p) => p.number === number && (repository === undefined || p.repository.toLowerCase() === repository),
  );

  if (matches.length === 1) return { pr: matches[0]! };

  if (matches.length > 1)
    return { problem: `Several linked pull requests have number ${number}; name it as owner/repo#${number}.` };

  return { problem: `${value} is not linked to this thread. ${listed} ${hint}` };
}
