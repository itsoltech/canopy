import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";

export const uncertainMutation = "Couldn't confirm. Check on GitHub";

export function mutationRequest(
  snapshot: github.PullRequestSnapshot,
  requestId: string,
  action: string,
  fields: MessageInitShape<typeof github.PullRequestMutationRequestSchema> = {},
) {
  return create(github.PullRequestMutationRequestSchema, {
    pullRequestId: snapshot.summary?.ref?.id ?? "",
    accountId: snapshot.accountId,
    accessRevision: snapshot.accessRevision,
    headSha: snapshot.summary?.headSha ?? "",
    expectedState: snapshot.summary?.state ?? "",
    baseSha: snapshot.baseSha,
    clientRequestId: requestId,
    action,
    ...fields,
  });
}

export interface MutationApi {
  updatePullRequestDetails: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  requestPullRequestReviewers: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestAssignees: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestLabels: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  createPullRequest: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestDraft: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  mergePullRequest: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestQueue: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestAutoMerge: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  updatePullRequestBranch: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestOpen: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  preparePullRequestMutation: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => Promise<github.PullRequestMutationReceipt>;
  createPullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  replyPullRequestReviewThread: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  updatePullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  deletePullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestFileViewed: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  addPullRequestReviewComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  submitPullRequestReview: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  discardPullRequestReview: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestReviewThreadResolved: (
    r: github.PullRequestMutationRequest,
  ) => Promise<github.PullRequestMutationReceipt>;
}

/** A lost UI response permits only a receipt lookup. Reconnect never invokes a mutation. */
export async function sendMutation(
  api: MutationApi,
  request: github.PullRequestMutationRequest,
  isRefusal: (cause: unknown) => boolean = () => false,
  refusalDetail: (cause: unknown) => string = () => "",
) {
  try {
    switch (request.action) {
      case "update_details":
        return await api.updatePullRequestDetails(request);
      case "request_reviewers":
        return await api.requestPullRequestReviewers(request);
      case "set_assignees":
        return await api.setPullRequestAssignees(request);
      case "set_labels":
        return await api.setPullRequestLabels(request);
      case "create_pr":
        return await api.createPullRequest(request);
      case "set_draft":
        return await api.setPullRequestDraft(request);
      case "merge":
        return await api.mergePullRequest(request);
      case "queue":
        return await api.setPullRequestQueue(request);
      case "auto_merge":
        return await api.setPullRequestAutoMerge(request);
      case "update_branch":
        return await api.updatePullRequestBranch(request);
      case "set_open":
        return await api.setPullRequestOpen(request);
      case "create_comment":
        return await api.createPullRequestComment(request);
      case "reply":
        return await api.replyPullRequestReviewThread(request);
      case "update_comment":
        return await api.updatePullRequestComment(request);
      case "delete_comment":
        return await api.deletePullRequestComment(request);
      case "viewed":
        return await api.setPullRequestFileViewed(request);
      case "add_review_comment":
        return await api.addPullRequestReviewComment(request);
      case "submit_review":
        return await api.submitPullRequestReview(request);
      case "discard_review":
        return await api.discardPullRequestReview(request);
      case "resolve_thread":
        return await api.setPullRequestReviewThreadResolved(request);
      default:
        throw new Error("Unsupported pull request mutation");
    }
  } catch (cause) {
    try {
      const receipt = await api.getPullRequestMutation(
        create(github.PullRequestMutationRequestRefSchema, {
          pullRequestId: request.pullRequestId,
          clientRequestId: request.clientRequestId,
          threadId: request.threadId,
        }),
      );

      if (receipt.state === "prepared") throw cause;

      return receipt;
    } catch {
      return create(github.PullRequestMutationReceiptSchema, {
        clientRequestId: request.clientRequestId,
        action: request.action,
        state: isRefusal(cause) ? "failed" : "uncertain",
        detail: isRefusal(cause)
          ? refusalDetail(cause) || "Could not save this change. Refresh and check repository access."
          : uncertainMutation,
      });
    }
  }
}

export const mutationUnconfirmed = (r: github.PullRequestMutationReceipt) =>
  ["uncertain", "in_flight"].includes(r.state);
