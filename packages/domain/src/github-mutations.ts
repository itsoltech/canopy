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
    clientRequestId: requestId,
    action,
    ...fields,
  });
}

export interface MutationApi {
  preparePullRequestMutation: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  getPullRequestMutation: (r: github.PullRequestMutationRequestRef) => Promise<github.PullRequestMutationReceipt>;
  createPullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  replyPullRequestReviewThread: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  updatePullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  deletePullRequestComment: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
  setPullRequestFileViewed: (r: github.PullRequestMutationRequest) => Promise<github.PullRequestMutationReceipt>;
}

/** A lost UI response permits only a receipt lookup. Reconnect never invokes a mutation. */
export async function sendMutation(
  api: MutationApi,
  request: github.PullRequestMutationRequest,
  isRefusal: (cause: unknown) => boolean = () => false,
) {
  try {
    switch (request.action) {
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
      default:
        throw new Error("Unsupported pull request mutation");
    }
  } catch (cause) {
    try {
      return await api.getPullRequestMutation(
        create(github.PullRequestMutationRequestRefSchema, {
          pullRequestId: request.pullRequestId,
          clientRequestId: request.clientRequestId,
        }),
      );
    } catch {
      return create(github.PullRequestMutationReceiptSchema, {
        clientRequestId: request.clientRequestId,
        action: request.action,
        state: isRefusal(cause) ? "failed" : "uncertain",
        detail: isRefusal(cause)
          ? "Could not save this change. Refresh and check repository access."
          : uncertainMutation,
      });
    }
  }
}

export const mutationUnconfirmed = (r: github.PullRequestMutationReceipt) =>
  ["uncertain", "in_flight"].includes(r.state);
