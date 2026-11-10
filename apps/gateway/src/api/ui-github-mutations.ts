import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { githubClient } from "./github-client.ts";
import { createPullRequest, reconcileCreate } from "../github/create.ts";
import { createFormContext, prepareDraftContext } from "../github/create-context.ts";
import { mutationReceipt } from "../github/mutations.ts";

export function githubMutationHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "preparePullRequestMutation"
  | "getPullRequestMutation"
  | "createPullRequestComment"
  | "replyPullRequestReviewThread"
  | "updatePullRequestComment"
  | "deletePullRequestComment"
  | "setPullRequestFileViewed"
  | "addPullRequestReviewComment"
  | "submitPullRequestReview"
  | "discardPullRequestReview"
  | "setPullRequestReviewThreadResolved"
  | "getPullRequestCreateContext"
  | "preparePullRequestDraftContext"
  | "createPullRequest"
  | "setPullRequestDraft"
  | "mergePullRequest"
  | "setPullRequestQueue"
  | "setPullRequestAutoMerge"
  | "updatePullRequestBranch"
  | "setPullRequestOpen"
  | "updatePullRequestDetails"
  | "requestPullRequestReviewers"
  | "setPullRequestAssignees"
  | "setPullRequestLabels"
> {
  const action =
    (expected: string) =>
    (
      r: Parameters<UiHandlers["createPullRequestComment"]>[0],
      c: Parameters<UiHandlers["createPullRequestComment"]>[1],
    ) => {
      if (r.action !== expected)
        throw new ConnectError("Choose a supported pull request action.", Code.InvalidArgument);

      return core.github.mutations.run(r, githubClient(c, r.clientBinding));
    };

  return {
    preparePullRequestMutation: (r, c) =>
      r.action === "create_pr"
        ? createPullRequest(core, r, githubClient(c, r.clientBinding), true)
        : core.github.mutations.run(r, githubClient(c, r.clientBinding), true),
    getPullRequestMutation: async (r, c) => {
      const receipt = await core.github.mutations.get(r, githubClient(c, r.clientBinding));

      if (r.threadId && receipt.state === "accepted") {
        const row = (await core.github.run((s) => s.mutationGet(core.github.owner, r.clientRequestId)))[0];

        if (row) {
          try {
            return mutationReceipt(await reconcileCreate(core, row));
          } catch {
            return receipt;
          }
        }
      }

      return receipt;
    },
    getPullRequestCreateContext: (r) => createFormContext(core, r),
    preparePullRequestDraftContext: (r) => prepareDraftContext(core, r),
    createPullRequest: (r, c) => createPullRequest(core, r, githubClient(c, r.clientBinding)),
    setPullRequestDraft: action("set_draft"),
    mergePullRequest: action("merge"),
    setPullRequestQueue: action("queue"),
    setPullRequestAutoMerge: action("auto_merge"),
    updatePullRequestBranch: action("update_branch"),
    setPullRequestOpen: action("set_open"),
    updatePullRequestDetails: action("update_details"),
    requestPullRequestReviewers: action("request_reviewers"),
    setPullRequestAssignees: action("set_assignees"),
    setPullRequestLabels: action("set_labels"),
    createPullRequestComment: action("create_comment"),
    replyPullRequestReviewThread: action("reply"),
    updatePullRequestComment: action("update_comment"),
    deletePullRequestComment: action("delete_comment"),
    setPullRequestFileViewed: action("viewed"),
    addPullRequestReviewComment: action("add_review_comment"),
    submitPullRequestReview: action("submit_review"),
    discardPullRequestReview: action("discard_review"),
    setPullRequestReviewThreadResolved: action("resolve_thread"),
  };
}
