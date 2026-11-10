import { github } from "@canopy/contracts";
import { draftPullRequest } from "@canopy/domain/github-agent-draft";
import { readMessage } from "./body.ts";
import type { gateway } from "./gateway.ts";
import { encode } from "#lib/shared/wire.ts";

export async function githubMutation(
  api: ReturnType<typeof gateway>,
  operation: string,
  request: Request,
  binding: string,
) {
  const options = { headers: { "canopy-github-client": binding }, timeoutMs: 120_000 };

  if (operation === "agent-draft") {
    const r = await readMessage(request, github.PullRequestCreateContextRequestSchema);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
    const context = await api.preparePullRequestDraftContext(r, { ...options, signal });

    return draftPullRequest(api, r.threadId, context, crypto.randomUUID(), signal);
  }

  if (operation === "create-context")
    return encode(
      github.PullRequestCreateContextSchema,
      await api.getPullRequestCreateContext(
        await readMessage(request, github.PullRequestCreateContextRequestSchema),
        options,
      ),
    );

  if (operation === "draft-context")
    return encode(
      github.PullRequestContextResponseSchema,
      await api.preparePullRequestDraftContext(
        await readMessage(request, github.PullRequestCreateContextRequestSchema),
        options,
      ),
    );

  if (operation === "mutation")
    return encode(
      github.PullRequestMutationReceiptSchema,
      await api.getPullRequestMutation(await readMessage(request, github.PullRequestMutationRequestRefSchema), options),
    );

  if (
    ![
      "prepare-mutation",
      "create-comment",
      "reply",
      "update-comment",
      "delete-comment",
      "viewed",
      "add-review-comment",
      "submit-review",
      "discard-review",
      "resolve-thread",
      "create-pr",
      "set-draft",
      "merge",
      "queue",
      "auto-merge",
      "update-branch",
      "set-open",
      "update-details",
      "request-reviewers",
      "set-assignees",
      "set-labels",
    ].includes(operation)
  )
    return undefined;
  const r = await readMessage(request, github.PullRequestMutationRequestSchema);

  async function run() {
    switch (operation) {
      case "update-details":
        return api.updatePullRequestDetails(r, options);
      case "request-reviewers":
        return api.requestPullRequestReviewers(r, options);
      case "set-assignees":
        return api.setPullRequestAssignees(r, options);
      case "set-labels":
        return api.setPullRequestLabels(r, options);
      case "create-pr":
        return api.createPullRequest(r, options);
      case "set-draft":
        return api.setPullRequestDraft(r, options);
      case "merge":
        return api.mergePullRequest(r, options);
      case "queue":
        return api.setPullRequestQueue(r, options);
      case "auto-merge":
        return api.setPullRequestAutoMerge(r, options);
      case "update-branch":
        return api.updatePullRequestBranch(r, options);
      case "set-open":
        return api.setPullRequestOpen(r, options);
      case "prepare-mutation":
        return api.preparePullRequestMutation(r, options);
      case "create-comment":
        return api.createPullRequestComment(r, options);
      case "reply":
        return api.replyPullRequestReviewThread(r, options);
      case "update-comment":
        return api.updatePullRequestComment(r, options);
      case "delete-comment":
        return api.deletePullRequestComment(r, options);
      case "add-review-comment":
        return api.addPullRequestReviewComment(r, options);
      case "submit-review":
        return api.submitPullRequestReview(r, options);
      case "discard-review":
        return api.discardPullRequestReview(r, options);
      case "resolve-thread":
        return api.setPullRequestReviewThreadResolved(r, options);
      default:
        return api.setPullRequestFileViewed(r, options);
    }
  }

  const value = await run();

  return encode(github.PullRequestMutationReceiptSchema, value);
}
