import { Code, ConnectError } from "@connectrpc/connect";
import { Option, Schema } from "effect";
import type { MutationScope } from "./mutation-preflight.ts";
import type { github } from "@canopy/contracts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { AccessToken } from "./access.ts";

export interface MutationAccess {
  prs: GitHubPullRequests;
  access: AccessToken;
}

/** Each request already reserved one point. Record measured cost and upstream limits. */
export async function mutationBudget(scope: MutationAccess, value: Schema.JsonObject | null, headers: Headers) {
  const parsed = Schema.decodeUnknownOption(
    Schema.Struct({
      data: Schema.Struct({
        rateLimit: Schema.Struct({ cost: Schema.Number, remaining: Schema.Number, resetAt: Schema.String }),
      }),
    }),
  )(value);

  const rate = Option.getOrUndefined(parsed)?.data.rateLimit;
  const number = (name: string) => (headers.has(name) ? Number(headers.get(name)) : undefined);
  await scope.prs.accounts.run((s) =>
    s.budgetRecord(
      scope.access.row.github_user_id,
      "graphql",
      {
        cost: Math.max(0, (rate?.cost ?? 1) - 1),
        remaining: rate?.remaining ?? number("x-ratelimit-remaining"),
        limit: number("x-ratelimit-limit"),
        reset: rate
          ? Date.parse(rate.resetAt)
          : number("x-ratelimit-reset")
            ? Number(headers.get("x-ratelimit-reset")) * 1000
            : undefined,
        failed: false,
      },
      scope.prs.accounts.http.now(),
    ),
  );
}

export function mutationInput(scope: MutationScope, r: github.PullRequestMutationRequest): Schema.JsonObject {
  if (r.action === "create_comment") return { subjectId: scope.pr.node_id, body: r.body };

  if (r.action === "reply") return { pullRequestReviewThreadId: r.resourceId, body: r.body };

  if (r.action === "viewed") return { pullRequestId: scope.pr.node_id, path: r.path };

  if (r.action === "update_comment")
    return { [r.commentKind === "issue" ? "id" : "pullRequestReviewCommentId"]: r.resourceId, body: r.body };

  return { id: r.resourceId };
}

/** Share the read queue and budget; no transaction spans network I/O and no write is replayed. */
export async function mutationQueue<T>(scope: MutationAccess, use: (renew: () => Promise<void>) => Promise<T>) {
  const { accounts } = scope.prs;
  const { run, http } = accounts;
  const user = scope.access.row.github_user_id;
  const lease = Bun.randomUUIDv7();
  const deadline = Date.now() + 30_000;

  while (!(await run((s) => s.apiClaim(user, lease)))) {
    if (Date.now() > deadline) throw new ConnectError("GitHub is busy. Try again in a moment.", Code.Unavailable);
    await Bun.sleep(50);
  }

  try {
    const budget = await run((s) => s.budget(user, "graphql", http.now()));

    if (
      Number(new Date(budget.retry_at)) > http.now() ||
      budget.used >= 1500 ||
      budget.remaining < budget.limit_count * 0.05
    )
      throw new ConnectError(
        "GitHub's request limit is reached. Try again after the limit resets.",
        Code.ResourceExhausted,
      );

    while (!(await run((s) => s.mutationPace(user))).length) await Bun.sleep(50);
    // Reserve the preflight and mutation cost before sending, including lost responses.
    await run((s) => s.budgetRecord(user, "graphql", { cost: 2, failed: false }, http.now()));

    return await use(async () => {
      if (!(await run((s) => s.apiRenew(lease))).length)
        throw new ConnectError(
          "Review verification expired. Refresh and check the comments before sending.",
          Code.FailedPrecondition,
        );
    });
  } finally {
    await run((s) => s.apiRelease(lease));
  }
}

export function mutationDocument(action: string, kind: string) {
  if (action === "create_comment")
    return `mutation CanopyCreateComment($input:AddCommentInput!){result:addComment(input:$input){node{id}}}`;

  if (action === "reply")
    return `mutation CanopyReply($input:AddPullRequestReviewThreadReplyInput!){result:addPullRequestReviewThreadReply(input:$input){comment{id}}}`;

  if (action === "viewed") return "";

  if (action === "update_comment")
    return kind === "issue"
      ? `mutation CanopyUpdateComment($input:UpdateIssueCommentInput!){result:updateIssueComment(input:$input){issueComment{id}}}`
      : `mutation CanopyUpdateReviewComment($input:UpdatePullRequestReviewCommentInput!){result:updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}`;

  return kind === "issue"
    ? `mutation CanopyDeleteComment($input:DeleteIssueCommentInput!){result:deleteIssueComment(input:$input){clientMutationId}}`
    : `mutation CanopyDeleteReviewComment($input:DeletePullRequestReviewCommentInput!){result:deletePullRequestReviewComment(input:$input){clientMutationId}}`;
}
