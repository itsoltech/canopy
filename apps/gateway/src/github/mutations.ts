import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { digest } from "./read-scope.ts";
import { uuid } from "./records.ts";
import { githubFailure, GitHubHttpFailure } from "./http.ts";
import { mutationScope, preflight, type MutationScope } from "./mutation-preflight.ts";
import { mutationDocument, mutationQueue, mutationInput, mutationBudget } from "./mutation-http.ts";
import { uncertainDetail, type MutationRow } from "./store-mutations.ts";
import { viewedFiles } from "./viewed.ts";
import { validateReview, reviewMutation, reviewParameters } from "./review-mutation.ts";
import { verifyReviewAnchor, reviewPreflight } from "./review-preflight.ts";

const actions = [
  "create_comment",
  "reply",
  "update_comment",
  "delete_comment",
  "viewed",
  "add_review_comment",
  "submit_review",
  "discard_review",
  "resolve_thread",
];

const result = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      result: Schema.NullOr(
        Schema.Struct({
          node: Schema.optional(Schema.Struct({ id: Schema.String })),
          comment: Schema.optional(Schema.Struct({ id: Schema.String })),
          issueComment: Schema.optional(Schema.Struct({ id: Schema.String })),
          pullRequestReviewComment: Schema.optional(Schema.Struct({ id: Schema.String })),
          clientMutationId: Schema.optional(Schema.NullOr(Schema.String)),
          pullRequest: Schema.optional(Schema.Struct({ id: Schema.String })),
          pullRequestReview: Schema.optional(Schema.Struct({ id: Schema.String })),
          thread: Schema.optional(Schema.Struct({ id: Schema.String })),
        }),
      ),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});

export function mutationReceipt(r: MutationRow) {
  return create(github.PullRequestMutationReceiptSchema, {
    clientRequestId: r.request_id,
    action: r.action,
    state: r.state,
    upstreamId: r.upstream_id,
    detail: r.detail,
    confirmationId: r.state === "prepared" ? r.confirmation_id : "",
    expiresAt: timestampFromDate(new Date(r.expires_at)),
    viewerViewedState: r.viewer_viewed_state,
  });
}

function validate(r: github.PullRequestMutationRequest) {
  validateReview(r);

  if (!uuid(r.pullRequestId) || !uuid(r.accountId) || !uuid(r.clientRequestId))
    throw new ConnectError("Pull request not found", Code.NotFound);

  if (
    !actions.includes(r.action) ||
    !/^[a-f0-9]{40}$/.test(r.headSha) ||
    !["open", "draft", "merged", "closed"].includes(r.expectedState)
  )
    throw new ConnectError("Refresh this pull request before sending.", Code.InvalidArgument);

  if (
    ["reply", "update_comment", "delete_comment", "resolve_thread", "discard_review"].includes(r.action) &&
    !/^[A-Za-z0-9_=-]{1,256}$/.test(r.resourceId)
  )
    throw new ConnectError("Comment not found", Code.NotFound);

  if (["update_comment", "delete_comment"].includes(r.action) && !["issue", "review"].includes(r.commentKind))
    throw new ConnectError("Comment not found", Code.NotFound);

  if (
    ["create_comment", "reply", "update_comment"].includes(r.action) &&
    (!r.body.trim() || Buffer.byteLength(r.body) > 65536 || r.body.includes(String.fromCharCode(0)))
  )
    throw new ConnectError("Write a comment of up to 64 KiB.", Code.InvalidArgument);

  if (
    ["viewed", "add_review_comment"].includes(r.action) &&
    (!r.path || r.path.length > 4096 || [...r.path].some((c) => c.charCodeAt(0) < 32))
  )
    throw new ConnectError("File not found", Code.NotFound);
}

export class GitHubMutations {
  constructor(readonly prs: GitHubPullRequests) {}
  async get(r: github.PullRequestMutationRequestRef, client: string) {
    if (!uuid(r.pullRequestId) || !uuid(r.clientRequestId)) throw new ConnectError("Mutation not found", Code.NotFound);
    const row = (await this.prs.accounts.run((s) => s.mutationGet(this.prs.accounts.owner, r.clientRequestId)))[0];

    if (!row || row.pull_request_id !== r.pullRequestId || row.client_binding !== client)
      throw new ConnectError("Mutation not found", Code.NotFound);

    return mutationReceipt(row);
  }
  async run(r: github.PullRequestMutationRequest, client: string, prepare = false) {
    validate(r);
    const { accounts } = this.prs;

    const fingerprint = digest(
      JSON.stringify([
        client,
        r.pullRequestId,
        r.accountId,
        String(r.accessRevision),
        r.headSha,
        r.expectedState,
        r.action,
        r.resourceId,
        r.commentKind,
        r.body,
        r.path,
        r.viewed,
        reviewParameters(r),
      ]),
    );

    const read = async () => (await accounts.run((s) => s.mutationGet(accounts.owner, r.clientRequestId)))[0];
    let row = await read();

    if (row && (row.fingerprint !== fingerprint || row.client_binding !== client))
      throw new ConnectError("This request belongs to another action. Refresh before sending.", Code.AlreadyExists);

    if (row && row.state !== "prepared") return mutationReceipt(row);

    try {
      const scope = await mutationScope(this.prs, r);

      if (r.action === "add_review_comment") await verifyReviewAnchor(scope, r);

      if (r.action === "viewed") {
        const snapshot = await this.prs.load(scope.pr.repository_name, scope.pr.number, true);
        const files = await viewedFiles(this.prs, scope.access.row, scope.pr, r.headSha, snapshot.baseSha, true);

        if (!files.states.has(r.path)) throw new ConnectError("File not found in this pull request", Code.NotFound);
      }

      return await mutationQueue(scope, async (renew) => {
        // A second click may have waited behind the first network call.
        row = await read();

        if (row && row.state !== "prepared") return mutationReceipt(row);
        await preflight(scope, r, scope.access);
        await reviewPreflight(scope, r, renew);
        await renew();
        row = (
          await accounts.run((s) => s.mutationPrepare(accounts.owner, client, r, fingerprint, scope.mapping.revision))
        )[0];

        if (!row || row.fingerprint !== fingerprint)
          throw new ConnectError("Request changed. Refresh before sending.", Code.AlreadyExists);

        if (prepare || row.state !== "prepared") return mutationReceipt(row);
        const claimed = await accounts.run((s) => s.mutationClaim(row!, r.confirmationId));

        if (!claimed)
          throw new ConnectError(
            "Confirmation expired or access changed. Refresh and confirm again.",
            Code.FailedPrecondition,
          );

        return this.send(scope, r, claimed);
      });
    } catch (cause) {
      await accounts.run((s) => s.mutationDenied(accounts.owner, client, r.pullRequestId, r.clientRequestId, r.action));
      throw githubFailure(cause);
    }
  }
  private async send(scope: MutationScope, r: github.PullRequestMutationRequest, row: MutationRow) {
    const { accounts } = this.prs;

    let state = "uncertain",
      upstream = "",
      detail = uncertainDetail;

    try {
      const review = reviewMutation(scope, r);
      const input = review?.input ?? mutationInput(scope, r);

      const query =
        review?.query ??
        (r.action === "viewed"
          ? r.viewed
            ? `mutation CanopyMarkViewed($input:MarkFileAsViewedInput!){result:markFileAsViewed(input:$input){pullRequest{id}}}`
            : `mutation CanopyUnmarkViewed($input:UnmarkFileAsViewedInput!){result:unmarkFileAsViewed(input:$input){pullRequest{id}}}`
          : mutationDocument(r.action, r.commentKind));

      // Deliberately bypass authorized(): even its 401 refresh retry must never replay a write.
      const response = await accounts.http.detailed(
        "/graphql",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${scope.access.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            variables: { input: { ...input, clientMutationId: r.clientRequestId } },
          }),
        },
        [scope.access.token, ...(scope.access.secrets ?? [])],
      );

      await mutationBudget(scope, response.value, response.headers);
      const parsed = Schema.decodeUnknownSync(result)(response.value);
      const payload = parsed.data?.result;

      if (payload && !parsed.errors?.length) {
        upstream =
          payload.node?.id ??
          payload.comment?.id ??
          payload.issueComment?.id ??
          payload.pullRequestReviewComment?.id ??
          payload.pullRequestReview?.id ??
          payload.thread?.id ??
          payload.pullRequest?.id ??
          payload.clientMutationId ??
          "";

        if (upstream) {
          state = "succeeded";
          detail = "";
        }
      } else if (
        !payload &&
        parsed.errors?.length &&
        parsed.errors.every((e) => ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE", "VALIDATION"].includes(e.type ?? ""))
      ) {
        state = "failed";
        detail = "GitHub declined this change. Refresh and check repository permissions.";
      }
    } catch (cause) {
      if (cause instanceof GitHubHttpFailure && [400, 401, 403, 404, 409, 422, 429].includes(cause.status)) {
        state = "failed";
        detail = "GitHub declined this change. Refresh and check repository permissions.";

        if (cause.status === 401) await accounts.run((s) => s.clearRevision(scope.access.row));

        if (cause.retryAt)
          await accounts.run((s) =>
            s.budgetRecord(
              scope.access.row.github_user_id,
              "graphql",
              { cost: 0, failed: true, retry: cause.retryAt },
              accounts.http.now(),
            ),
          );
      }
    }

    const saved = await accounts.run((s) => s.mutationFinish(row, state, upstream, detail));
    this.prs.client.memory.clear();

    return mutationReceipt(saved);
  }
}
