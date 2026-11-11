import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { githubFailure } from "../github/http.ts";

async function guard<A>(use: () => Promise<A>) {
  try {
    return await use();
  } catch (cause) {
    throw githubFailure(cause);
  }
}

export function pullRequestHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getGitHubRepositoryAccount"
  | "setGitHubRepositoryAccount"
  | "listThreadPullRequests"
  | "linkThreadPullRequest"
  | "unlinkThreadPullRequest"
  | "getPullRequest"
  | "refreshPullRequest"
> {
  const prs = core.github.prs;

  return {
    getGitHubRepositoryAccount: (r) => guard(() => prs.repositories.get(r.repositoryName)),
    setGitHubRepositoryAccount: (r) => guard(() => prs.repositories.set(r)),
    listThreadPullRequests: (r) => guard(() => prs.list(r.threadId)),
    linkThreadPullRequest: (r) => guard(() => prs.link(r)),
    unlinkThreadPullRequest: (r) => guard(() => prs.unlink(r)),
    getPullRequest: (r) => guard(() => prs.get(r.pullRequestId, r.refresh)),
    refreshPullRequest: (r) => guard(() => prs.get(r.pullRequestId, true)),
  };
}
