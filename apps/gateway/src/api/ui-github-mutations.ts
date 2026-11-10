import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { githubClient } from "./github-client.ts";

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
    preparePullRequestMutation: (r, c) => core.github.mutations.run(r, githubClient(c, r.clientBinding), true),
    getPullRequestMutation: (r, c) => core.github.mutations.get(r, githubClient(c, r.clientBinding)),
    createPullRequestComment: action("create_comment"),
    replyPullRequestReviewThread: action("reply"),
    updatePullRequestComment: action("update_comment"),
    deletePullRequestComment: action("delete_comment"),
    setPullRequestFileViewed: action("viewed"),
  };
}
