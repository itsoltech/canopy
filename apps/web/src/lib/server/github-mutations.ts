import { github } from "@canopy/contracts";
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

  if (operation === "mutation")
    return encode(
      github.PullRequestMutationReceiptSchema,
      await api.getPullRequestMutation(await readMessage(request, github.PullRequestMutationRequestRefSchema), options),
    );

  if (
    !["prepare-mutation", "create-comment", "reply", "update-comment", "delete-comment", "viewed"].includes(operation)
  )
    return undefined;
  const r = await readMessage(request, github.PullRequestMutationRequestSchema);

  async function run() {
    switch (operation) {
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
      default:
        return api.setPullRequestFileViewed(r, options);
    }
  }

  const value = await run();

  return encode(github.PullRequestMutationReceiptSchema, value);
}
