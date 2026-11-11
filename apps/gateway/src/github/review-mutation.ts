import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { MutationScope } from "./mutation-preflight.ts";

export function validateReview(r: github.PullRequestMutationRequest) {
  if (
    ["add_review_comment", "submit_review", "discard_review"].includes(r.action) &&
    !["open", "draft"].includes(r.expectedState)
  )
    throw new ConnectError("This pull request is closed. Refresh before reviewing.", Code.FailedPrecondition);

  if (r.action === "submit_review" && !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(r.verdict))
    throw new ConnectError("Choose a review verdict.", Code.InvalidArgument);

  if (Buffer.byteLength(r.body) > 65536 || r.body.includes(String.fromCharCode(0)))
    throw new ConnectError("Write a review of up to 64 KiB.", Code.InvalidArgument);

  if (
    r.action === "add_review_comment" &&
    (!r.body.trim() || !r.path || r.path.length > 4096 || !r.line || r.sourcePage < 1 || r.sourcePage > 100)
  )
    throw new ConnectError("Select a diff line and write a comment before sending.", Code.InvalidArgument);

  if (r.resourceId && !/^[A-Za-z0-9_=-]{1,256}$/.test(r.resourceId))
    throw new ConnectError("Review not found", Code.NotFound);

  if (r.reviewRevision.length > 13000)
    throw new ConnectError("Review exceeds the page limit. Open on GitHub to submit it.", Code.ResourceExhausted);
}

export function reviewMutation(
  scope: MutationScope,
  r: github.PullRequestMutationRequest,
): { query: string; input: Schema.JsonObject } | undefined {
  const review = (input: Schema.JsonObject) => ({
    query: `mutation CanopyAddReview($input:AddPullRequestReviewInput!){result:addPullRequestReview(input:$input){pullRequestReview{id}}}`,
    input: { pullRequestId: scope.pr.node_id, commitOID: r.headSha, ...input },
  });

  if (r.action === "add_review_comment") {
    const anchor = {
      path: r.path,
      body: r.body,
      side: r.side,
      line: r.line,
      ...(r.startLine &&
        (r.startLine !== r.line || r.startSide !== r.side) && { startSide: r.startSide, startLine: r.startLine }),
    };

    if (!r.resourceId) return review({ threads: [anchor], ...(r.singleComment && { event: "COMMENT" }) });

    return {
      query: `mutation CanopyAddReviewThread($input:AddPullRequestReviewThreadInput!){result:addPullRequestReviewThread(input:$input){thread{id}}}`,
      input: { pullRequestReviewId: r.resourceId, ...anchor },
    };
  }

  if (r.action === "submit_review")
    return r.resourceId
      ? {
          query: `mutation CanopySubmitReview($input:SubmitPullRequestReviewInput!){result:submitPullRequestReview(input:$input){pullRequestReview{id}}}`,
          input: { pullRequestReviewId: r.resourceId, body: r.body, event: r.verdict },
        }
      : review({ body: r.body, event: r.verdict });

  if (r.action === "discard_review")
    return {
      query: `mutation CanopyDiscardReview($input:DeletePullRequestReviewInput!){result:deletePullRequestReview(input:$input){clientMutationId}}`,
      input: { pullRequestReviewId: r.resourceId },
    };

  if (r.action === "resolve_thread")
    return {
      query: r.resolved
        ? `mutation CanopyResolveThread($input:ResolveReviewThreadInput!){result:resolveReviewThread(input:$input){thread{id}}}`
        : `mutation CanopyUnresolveThread($input:UnresolveReviewThreadInput!){result:unresolveReviewThread(input:$input){thread{id}}}`,
      input: { threadId: r.resourceId },
    };

  return undefined;
}

export const reviewParameters = (r: github.PullRequestMutationRequest) => ({
  side: r.side,
  line: r.line,
  startSide: r.startSide,
  startLine: r.startLine,
  commitSha: r.commitSha,
  sourcePage: r.sourcePage,
  singleComment: r.singleComment,
  verdict: r.verdict,
  reviewRevision: r.reviewRevision,
  acknowledgeOutdated: r.acknowledgeOutdated,
  resolved: r.resolved,
});
