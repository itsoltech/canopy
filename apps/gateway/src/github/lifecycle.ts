import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema, Match } from "effect";
import type { MutationScope } from "./mutation-preflight.ts";
import { mutationBudget } from "./mutation-http.ts";
import { graphErrors } from "./read-scope.ts";
import {
  LIFECYCLE_FIELDS,
  LIFECYCLE_REPOSITORY_FIELDS,
  LifecycleRepository,
  lifecycleState,
} from "./lifecycle-state.ts";

export const lifecycleActions = ["set_draft", "merge", "queue", "auto_merge", "update_branch", "set_open"];

export const lifecycleParameters = (r: github.PullRequestMutationRequest) => ({
  baseSha: r.baseSha,
  method: r.method,
  enabled: r.enabled,
  draft: r.draft,
  threadId: r.threadId,
  repositoryName: r.repositoryName,
  headRepositoryName: r.headRepositoryName,
  headRef: r.headRef,
  baseRef: r.baseRef,
  maintainerCanModify: r.maintainerCanModify,
});

export function validateLifecycle(r: github.PullRequestMutationRequest) {
  if (!lifecycleActions.includes(r.action) && r.action !== "create_pr") return;

  if (!/^[a-f0-9]{40}$/.test(r.baseSha) || !/^[a-f0-9]{40}$/.test(r.headSha))
    throw new ConnectError("The branches changed. Refresh and confirm again.", Code.FailedPrecondition);

  if (["merge", "update_branch"].includes(r.action) || (r.action === "auto_merge" && r.enabled)) {
    if (!["MERGE", "SQUASH", "REBASE"].includes(r.method) || (r.action === "update_branch" && r.method === "SQUASH"))
      throw new ConnectError("Choose a supported merge method.", Code.InvalidArgument);
  }

  if (
    r.title.length > 256 ||
    r.title.includes("\n") ||
    r.title.includes(String.fromCharCode(0)) ||
    Buffer.byteLength(r.body) > 65536 ||
    r.body.includes(String.fromCharCode(0))
  )
    throw new ConnectError("Use a title up to 256 characters and a description up to 64 KiB.", Code.InvalidArgument);
}

export async function lifecyclePreflight(scope: MutationScope, r: github.PullRequestMutationRequest) {
  const response = await scope.prs.accounts.http.detailed(
    "/graphql",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${scope.access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query CanopyLifecyclePreflight($owner:String!,$name:String!,$number:Int!){rateLimit{cost remaining resetAt}
repository(owner:$owner,name:$name){databaseId viewerPermission ${LIFECYCLE_REPOSITORY_FIELDS}
pullRequest(number:$number){id headRefOid baseRefOid headRefName baseRefName state isDraft ${LIFECYCLE_FIELDS}}}}`,
        variables: {
          owner: scope.pr.repository_name.split("/")[0],
          name: scope.pr.repository_name.split("/")[1],
          number: scope.pr.number,
        },
      }),
    },
    [scope.access.token, ...(scope.access.secrets ?? [])],
  );

  await mutationBudget(scope, response.value, response.headers);

  if (!response.value || graphErrors(response.value))
    throw new ConnectError("Could not verify merge requirements. Refresh or check on GitHub.", Code.FailedPrecondition);

  const repo = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ repository: Schema.NullOr(LifecycleRepository) }) }),
  )(response.value).data.repository;

  const pr = repo?.pullRequest;

  if (!repo || String(repo.databaseId) !== scope.pr.repository_id || pr?.id !== scope.pr.node_id)
    throw new ConnectError("Pull request not found", Code.NotFound);

  if (
    pr.headRefOid !== r.headSha ||
    pr.baseRefOid !== r.baseSha ||
    (pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()) !== r.expectedState
  )
    throw new ConnectError("The branches changed. Refresh and confirm again.", Code.FailedPrecondition);
  const state = lifecycleState(repo, pr);

  const action = Match.value(r.action).pipe(
    Match.when("set_draft", () => (r.draft ? "draft" : "ready")),
    Match.when("set_open", () => (r.enabled ? "reopen" : "close")),
    Match.when("queue", () => (r.enabled ? "enqueue" : "dequeue")),
    Match.when("auto_merge", () => (r.enabled ? "enable_auto_merge" : "disable_auto_merge")),
    Match.orElse((value) => value),
  );

  if (!state.actions.includes(action))
    throw new ConnectError(
      state.blockingReasons[0] ?? "GitHub does not allow this action. Refresh or check repository access.",
      Code.FailedPrecondition,
    );

  if ((r.action === "merge" || (r.action === "auto_merge" && r.enabled)) && !state.mergeMethods.includes(r.method))
    throw new ConnectError("This merge method is disabled. Choose another method.", Code.FailedPrecondition);

  if (r.action === "update_branch" && !state.updateMethods.includes(r.method))
    throw new ConnectError("This update method is disabled. Choose another method.", Code.FailedPrecondition);

  if (scope.access.row.auth_kind === "device") {
    const rights = await scope.prs.accounts.run((s) =>
      s.mutationPermission(scope.prs.accounts.owner, r.accountId, scope.pr.repository_id),
    );

    const required =
      r.action === "queue"
        ? ["pull_requests", "contents", "merge_queues"]
        : ["merge", "update_branch"].includes(r.action) || (r.action === "auto_merge" && r.enabled)
          ? ["pull_requests", "contents"]
          : ["pull_requests"];

    if (!rights.some((i) => required.every((p) => i.permissions[p] === "write")))
      throw new ConnectError(
        "GitHub permissions changed. Manage repository access, then retry.",
        Code.PermissionDenied,
      );

    if (r.action === "update_branch") {
      const headRights = await scope.prs.accounts.run((s) =>
        s.mutationPermission(scope.prs.accounts.owner, r.accountId, String(pr.headRef?.repository.databaseId ?? "")),
      );

      if (!headRights.some((i) => i.permissions["contents"] === "write"))
        throw new ConnectError(
          "This account cannot update the fork. Manage head repository access.",
          Code.PermissionDenied,
        );
    }
  }
}

export function lifecycleMutation(scope: MutationScope, r: github.PullRequestMutationRequest) {
  if (r.action === "merge")
    return {
      path: `/repos/${scope.pr.repository_name}/pulls/${scope.pr.number}/merge`,
      method: "PUT",
      body: {
        sha: r.headSha,
        merge_method: r.method.toLowerCase(),
        ...(r.method === "SQUASH" && { commit_title: r.title, commit_message: r.body }),
      },
      accepted: false,
    };
  let input: Schema.JsonObject = { pullRequestId: scope.pr.node_id, clientMutationId: r.clientRequestId };

  let name = "",
    type = "";

  if (r.action === "set_draft") {
    name = r.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    type = r.draft ? "ConvertPullRequestToDraftInput" : "MarkPullRequestReadyForReviewInput";
  }

  if (r.action === "set_open") {
    name = r.enabled ? "reopenPullRequest" : "closePullRequest";
    type = r.enabled ? "ReopenPullRequestInput" : "ClosePullRequestInput";
  }

  if (r.action === "auto_merge") {
    name = r.enabled ? "enablePullRequestAutoMerge" : "disablePullRequestAutoMerge";
    type = r.enabled ? "EnablePullRequestAutoMergeInput" : "DisablePullRequestAutoMergeInput";

    if (r.enabled)
      Object.assign(input, {
        expectedHeadOid: r.headSha,
        mergeMethod: r.method,
        ...(r.method === "SQUASH" && { commitHeadline: r.title, commitBody: r.body }),
      });
  }

  if (r.action === "queue") {
    name = r.enabled ? "enqueuePullRequest" : "dequeuePullRequest";
    type = r.enabled ? "EnqueuePullRequestInput" : "DequeuePullRequestInput";
    input = r.enabled
      ? { ...input, expectedHeadOid: r.headSha }
      : { id: scope.pr.node_id, clientMutationId: r.clientRequestId };
  }

  if (r.action === "update_branch") {
    name = "updatePullRequestBranch";
    type = "UpdatePullRequestBranchInput";
    Object.assign(input, { expectedHeadOid: r.headSha, updateMethod: r.method });
  }

  const field = r.action === "queue" && r.enabled ? "mergeQueueEntry{id}" : "pullRequest{id}";

  return {
    path: "/graphql",
    method: "POST",
    body: {
      query: `mutation CanopyLifecycle($input:${type}!){result:${name}(input:$input){${field}}}`,
      variables: { input },
    },
    accepted: r.action === "update_branch" || ((r.action === "auto_merge" || r.action === "queue") && r.enabled),
  };
}
