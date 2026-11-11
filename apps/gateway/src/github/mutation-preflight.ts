import { Schema } from "effect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { github } from "@canopy/contracts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { AccessToken } from "./access.ts";
import { graphErrors } from "./read-scope.ts";
import { mutationBudget } from "./mutation-http.ts";
import { lifecycleActions } from "./lifecycle.ts";
import { metadataActions } from "./metadata-mutation.ts";

const pr = Schema.Struct({ id: Schema.String });

const target = Schema.Struct({
  __typename: Schema.String,
  id: Schema.String,
  issue: Schema.optional(Schema.Struct({ id: Schema.String })),
  pullRequest: Schema.optional(Schema.NullOr(pr)),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ databaseId: Schema.optional(Schema.NullOr(Schema.Number)) }))),
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerCanDelete: Schema.optional(Schema.Boolean),
  viewerCanResolve: Schema.optional(Schema.Boolean),
  viewerCanUnresolve: Schema.optional(Schema.Boolean),
});

const envelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        databaseId: Schema.Number,
        viewerPermission: Schema.NullOr(Schema.String),
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            state: Schema.String,
            isDraft: Schema.Boolean,
          }),
        ),
      }),
    ),
    node: Schema.NullOr(target),
  }),
});

export const MUTATION_PREFLIGHT = `query CanopyMutationPreflight($owner:String!,$name:String!,$number:Int!,$resource:ID!){
rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){databaseId viewerPermission
pullRequest(number:$number){id headRefOid state isDraft}} node(id:$resource){__typename id
... on IssueComment{pullRequest{id} author{... on User{databaseId}} viewerCanUpdate viewerCanDelete}
... on PullRequestReviewComment{pullRequest{id} author{... on User{databaseId}} viewerCanUpdate viewerCanDelete}
... on PullRequestReviewThread{pullRequest{id} viewerCanResolve viewerCanUnresolve}}}`;

export async function mutationScope(prs: GitHubPullRequests, r: github.PullRequestMutationRequest) {
  const { accounts, repositories } = prs;
  const pr = await accounts.run((s) => s.prOwned(accounts.owner, r.pullRequestId));
  const selected = await repositories.selected(pr.repository_name);

  if (selected.row.id !== r.accountId || BigInt(selected.row.revision) !== r.accessRevision)
    throw new ConnectError("Repository account changed. Refresh before sending.", Code.FailedPrecondition);
  // Writes always revalidate the installation; its fifteen-minute read cache is insufficient here.
  await accounts.catalogue.refresh(r.accountId, true);
  const access = await accounts.access.token(r.accountId);

  if (access.row.revision !== selected.row.revision)
    throw new ConnectError("Account changed. Refresh before sending.", Code.FailedPrecondition);

  if (access.row.auth_kind === "device") {
    const installed = await accounts.run((s) => s.mutationPermission(accounts.owner, r.accountId, pr.repository_id));

    const permitted = installed.some(
      (i) =>
        (["set_assignees", "set_labels"].includes(r.action)
          ? i.permissions["issues"] === "write"
          : i.permissions["pull_requests"] === "write") ||
        (r.action === "create_comment" && i.permissions["issues"] === "write") ||
        (["update_comment", "delete_comment"].includes(r.action) &&
          r.commentKind === "issue" &&
          i.permissions["issues"] === "write"),
    );

    if (!permitted)
      throw new ConnectError("GitHub permission changed. Manage repository access, then retry.", Code.PermissionDenied);
  }

  return { prs, pr, mapping: selected.mapping, access };
}

export type MutationScope = Awaited<ReturnType<typeof mutationScope>>;

export async function preflight(scope: MutationScope, r: github.PullRequestMutationRequest, access: AccessToken) {
  const { accounts } = scope.prs;

  const response = await accounts.http.detailed(
    "/graphql",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: MUTATION_PREFLIGHT,
        variables: {
          owner: scope.pr.repository_name.split("/")[0],
          name: scope.pr.repository_name.split("/")[1],
          number: scope.pr.number,
          resource: r.resourceId || scope.pr.node_id,
        },
      }),
    },
    [access.token, ...(access.secrets ?? [])],
  );

  const value = response.value;
  await mutationBudget(scope, value, response.headers);

  if (!value || graphErrors(value))
    throw new ConnectError("Could not verify GitHub permissions. Refresh, then retry.", Code.FailedPrecondition);
  const data = Schema.decodeUnknownSync(envelope)(value).data;
  const repo = data.repository;
  const pr = repo?.pullRequest;

  if (
    !repo ||
    !repo.viewerPermission ||
    String(repo.databaseId) !== scope.pr.repository_id ||
    pr?.id !== scope.pr.node_id
  )
    throw new ConnectError("Pull request not found", Code.NotFound);

  if (
    pr.headRefOid !== r.headSha ||
    (pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()) !== r.expectedState
  )
    throw new ConnectError("Pull request changed. Refresh before sending.", Code.FailedPrecondition);

  if (
    ![
      "create_comment",
      "viewed",
      "add_review_comment",
      "submit_review",
      "discard_review",
      ...lifecycleActions,
      ...metadataActions,
    ].includes(r.action)
  ) {
    const n = data.node;

    const kind = ["reply", "resolve_thread"].includes(r.action)
      ? "PullRequestReviewThread"
      : r.commentKind === "issue"
        ? "IssueComment"
        : "PullRequestReviewComment";

    if (!n || n.id !== r.resourceId || n.__typename !== kind || (n.issue?.id ?? n.pullRequest?.id) !== pr.id)
      throw new ConnectError("Comment or review thread not found", Code.NotFound);

    if (
      !["reply", "resolve_thread"].includes(r.action) &&
      (String(n.author?.databaseId) !== access.row.github_user_id ||
        !(r.action === "delete_comment" ? n.viewerCanDelete : n.viewerCanUpdate))
    )
      throw new ConnectError("Comment not found", Code.NotFound);

    if (r.action === "resolve_thread" && !(r.resolved ? n.viewerCanResolve : n.viewerCanUnresolve))
      throw new ConnectError(
        "GitHub does not allow changing this conversation. Check repository permissions.",
        Code.PermissionDenied,
      );
  }

  const current = await scope.prs.repositories.selected(scope.pr.repository_name);

  if (
    current.row.id !== access.row.id ||
    current.row.revision !== access.row.revision ||
    current.mapping.revision !== scope.mapping.revision
  )
    throw new ConnectError("Repository access changed. Refresh before sending.", Code.FailedPrecondition);
}
