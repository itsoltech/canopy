import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { reviewOutdated, reviewRevision } from "@canopy/domain/github-review";
import { diffAnchors, diffRange } from "@canopy/domain/diff-anchors";
import { draftHeader, draftPage, draftPath, REVIEW_DRAFT_QUERY } from "./review-draft.ts";
import { readScope } from "./read-scope.ts";
import { diff } from "./files.ts";
import { mutationBudget } from "./mutation-http.ts";
import type { MutationScope } from "./mutation-preflight.ts";

export async function verifyReviewAnchor(scope: MutationScope, r: github.PullRequestMutationRequest) {
  if (r.commitSha !== r.headSha)
    throw new ConnectError(
      "This comment uses an older version. Open the current changes, then select the lines again.",
      Code.FailedPrecondition,
    );

  const patch = await diff(
    await readScope(
      scope.prs,
      create(github.PullRequestPageRequestSchema, {
        pullRequestId: r.pullRequestId,
        headSha: r.headSha,
        path: r.path,
        resourceId: String(r.sourcePage),
      }),
      "diff",
    ),
  );

  const anchors = diffAnchors(patch.patch);

  if (
    !patch.patch ||
    patch.file?.patchState !== "available" ||
    !["LEFT", "RIGHT"].includes(r.side) ||
    (r.startLine && !["LEFT", "RIGHT"].includes(r.startSide))
  )
    throw new ConnectError("Select lines in the current diff before commenting.", Code.InvalidArgument);
  const startSide = r.startLine ? r.startSide : r.side;

  // SAFETY: both sides were checked against the complete DiffSide union above.
  const range = diffRange(
    anchors,
    { side: startSide as "LEFT" | "RIGHT", line: r.startLine || r.line },
    { side: r.side as "LEFT" | "RIGHT", line: r.line },
  );

  if (!range || range.side !== r.side || range.line !== r.line || range.startLine !== (r.startLine || r.line))
    throw new ConnectError("Select a range within one diff hunk, then retry.", Code.InvalidArgument);
}

/** This runs inside the shared API lease. Reads never recursively acquire the queue. */
async function read(scope: MutationScope, path: string, query = "", variables: Schema.JsonObject = {}) {
  const { accounts } = scope.prs;
  const resource = query ? "graphql" : "core";
  const budget = await accounts.run((s) => s.budget(scope.access.row.github_user_id, resource, accounts.http.now()));

  if (
    Number(new Date(budget.retry_at)) > accounts.http.now() ||
    budget.used >= (query ? 1500 : 1000) ||
    budget.remaining < budget.limit_count * 0.05
  )
    throw new ConnectError("GitHub's request limit is reached. Retry after the limit resets.", Code.ResourceExhausted);
  await accounts.run((s) =>
    s.budgetRecord(scope.access.row.github_user_id, resource, { cost: 1, failed: false }, accounts.http.now()),
  );

  const response = await accounts.http.detailed(
    path,
    {
      method: query ? "POST" : "GET",
      headers: { Authorization: `Bearer ${scope.access.token}`, ...(query && { "Content-Type": "application/json" }) },
      ...(query && { body: JSON.stringify({ query, variables }) }),
    },
    [scope.access.token, ...(scope.access.secrets ?? [])],
  );

  if (query) await mutationBudget(scope, response.value, response.headers);
  else
    await accounts.run((s) =>
      s.budgetRecord(
        scope.access.row.github_user_id,
        resource,
        {
          cost: 0,
          failed: false,
          remaining: Number(response.headers.get("x-ratelimit-remaining") ?? budget.remaining),
          limit: Number(response.headers.get("x-ratelimit-limit") ?? budget.limit_count),
        },
        accounts.http.now(),
      ),
    );

  if (!response.value)
    throw new ConnectError("Could not read the pending review. Refresh, then retry.", Code.Unavailable);

  return response;
}

export async function reviewPreflight(
  scope: MutationScope,
  r: github.PullRequestMutationRequest,
  renew: () => Promise<void>,
) {
  if (!["add_review_comment", "submit_review", "discard_review"].includes(r.action)) return;

  const response = await read(scope, "/graphql", REVIEW_DRAFT_QUERY, {
    owner: scope.pr.repository_name.split("/")[0]!,
    name: scope.pr.repository_name.split("/")[1]!,
    number: scope.pr.number,
    login: scope.access.row.login,
  });

  // SAFETY: read() refuses a response without a value.
  const h = draftHeader(response.value!, scope.pr, scope.access.row.github_user_id);

  if (h.head !== r.headSha)
    throw new ConnectError(
      "Changes updated. Refresh and check the review anchors before submitting.",
      Code.FailedPrecondition,
    );

  if (h.viewerIsAuthor && ["APPROVE", "REQUEST_CHANGES"].includes(r.verdict))
    throw new ConnectError(
      "GitHub does not allow reviewing your own pull request with this verdict. Choose Comment.",
      Code.PermissionDenied,
    );

  if (r.action === "add_review_comment" && r.singleComment && h.pending)
    throw new ConnectError("A pending review already exists. Review and submit it first.", Code.FailedPrecondition);

  if ((h.pending?.id ?? "") !== r.resourceId || (r.action === "discard_review" && !h.pending))
    throw new ConnectError(
      "Pending review changed on another device. Refresh and check all comments.",
      Code.FailedPrecondition,
    );

  if (r.action === "add_review_comment") {
    if (h.pending && h.pending.commit?.oid !== r.headSha)
      throw new ConnectError(
        "Changes updated. Submit or discard the existing review before adding new comments.",
        Code.FailedPrecondition,
      );

    return;
  }

  const pages: github.PullRequestReviewDraft[] = [];

  if (!h.pending)
    pages.push(draftPage({ items: [] }, h, scope.access.row.github_user_id, create(github.PullRequestPageInfoSchema)));
  else
    for (let page = 1; page <= 200; page++) {
      await renew();

      const response = await read(
        scope,
        draftPath(`/repos/${scope.pr.repository_name}`, scope.pr.number, h.pending.fullDatabaseId, page),
      );

      // SAFETY: read() refuses a response without a value.
      pages.push(
        draftPage(response.value!, h, scope.access.row.github_user_id, create(github.PullRequestPageInfoSchema)),
      );

      if (!(response.headers.get("link") ?? "").includes('rel="next"')) break;

      if (page === 200)
        throw new ConnectError("Review exceeds the page limit. Open on GitHub to submit it.", Code.ResourceExhausted);
    }

  if (
    pages.reduce((n, p) => n + p.comments.length, 0) !== (h.pending?.comments.totalCount ?? 0) ||
    reviewRevision(pages) !== r.reviewRevision
  )
    throw new ConnectError(
      "Pending review changed. Refresh and read all comments before submitting.",
      Code.FailedPrecondition,
    );

  if (r.action === "submit_review" && reviewOutdated(pages, r.headSha) && !r.acknowledgeOutdated)
    throw new ConnectError(
      "Changes updated. Check the outdated comments and confirm before submitting.",
      Code.FailedPrecondition,
    );

  if (
    r.action === "submit_review" &&
    !r.body.trim() &&
    (r.verdict === "REQUEST_CHANGES" || (r.verdict === "COMMENT" && !h.pending?.comments.totalCount))
  )
    throw new ConnectError("Write a review summary before submitting.", Code.InvalidArgument);

  await renew();

  const latest = await read(scope, "/graphql", REVIEW_DRAFT_QUERY, {
    owner: scope.pr.repository_name.split("/")[0]!,
    name: scope.pr.repository_name.split("/")[1]!,
    number: scope.pr.number,
    login: scope.access.row.login,
  });

  // SAFETY: read() refuses a response without a value.
  const current = draftHeader(latest.value!, scope.pr, scope.access.row.github_user_id);

  if (JSON.stringify(current) !== JSON.stringify(h))
    throw new ConnectError(
      "Pending review or changes updated during verification. Refresh and check all comments.",
      Code.FailedPrecondition,
    );
}
