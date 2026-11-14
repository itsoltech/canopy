import { toJson } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, type ConnectError } from "@connectrpc/connect";
import type { GitHubAccounts } from "./service.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";

/** A specific, actionable reason for the linked pull request row; never a vendor body or credential. */
export function refreshReason(name: string, error: ConnectError) {
  if (error.code === Code.PermissionDenied) return `No access to ${name}. Check the GitHub App installation.`;

  return error.rawMessage;
}

/** Complete reads become the last known summary; partial ones keep the previous complete summary. */
export async function rememberSummary(accounts: GitHubAccounts, account: string, snapshot: github.PullRequestSnapshot) {
  const summary = snapshot.summary;

  if (!summary?.ref?.id || snapshot.completeness === "partial") return;
  const value = toJson(github.PullRequestSummarySchema, summary);
  await accounts.run((s) => s.prRemember(accounts.owner, summary.ref!.id, account, value));
}

/**
 * One claimed attempt per pull request and interval. It never moves the thread's pull request revision, which
 * fences link and unlink; clients re-read while a stale link has no reason yet.
 */
export async function refreshLinked(prs: GitHubPullRequests, ref: github.PullRequestRef) {
  const { run, owner } = prs.accounts;

  if (!(await run((s) => s.prRefreshClaim(owner, ref.id))).length) return;

  // load() records the reason when the read fails.
  await prs.load(ref.repositoryName, ref.number, false, true).catch(() => undefined);
}
