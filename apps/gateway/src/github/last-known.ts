import { toJson } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, type ConnectError } from "@connectrpc/connect";
import type { GitHubAccounts } from "./service.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { AccountRow } from "./records.ts";

/** A specific, actionable reason for the linked pull request row; never a vendor body or credential. */
export function refreshReason(name: string, error: ConnectError) {
  if (error.code === Code.PermissionDenied) return `No access to ${name}. Check the GitHub App installation.`;

  return error.rawMessage;
}

/** Complete reads become the last known summary; partial ones keep the previous complete summary. */
export async function rememberSummary(accounts: GitHubAccounts, row: AccountRow, snapshot: github.PullRequestSnapshot) {
  const summary = snapshot.summary;

  if (!summary?.ref?.id || snapshot.completeness === "partial") return;
  const id = summary.ref.id;
  const value = toJson(github.PullRequestSummarySchema, summary);
  await accounts.run((s) => s.prRemember(accounts.owner, id, row.id, value, BigInt(row.revision)));
}

/** One claimed attempt per pull request and interval, including publication of any changed summary. */
export async function refreshLinked(prs: GitHubPullRequests, ref: github.PullRequestRef) {
  const { run, owner } = prs.accounts;

  if (!(await run((s) => s.prRefreshClaim(owner, ref.id))).length) return;

  // load() records the reason when the read fails. Wait for the refresh before projecting.
  await prs
    .load(ref.repositoryName, ref.number, false, true, true)
    .then(() => prs.pullRequestChanged(ref.id))
    .catch(() => {});
}
