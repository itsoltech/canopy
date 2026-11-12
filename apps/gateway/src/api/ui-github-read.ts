import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { readScope } from "../github/read-scope.ts";
import { timeline } from "../github/timeline-query.ts";
import { reviewThreads } from "../github/review-threads.ts";
import { reviewDraft } from "../github/review-draft.ts";
import { metadataPage } from "../github/metadata.ts";
import { checks, jobs } from "../github/checks.ts";
import { jobLog } from "../github/job-logs.ts";
import { commits, files, diff } from "../github/files.ts";
import { watchPullRequest } from "../github/watch.ts";
import { prepareContext } from "../github/context.ts";
import { githubFailure } from "../github/http.ts";
import { pullRequestAvatar } from "../github/avatars.ts";
import type { github } from "@canopy/contracts";

export function githubReadHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listPullRequestTimeline"
  | "getPullRequestAvatar"
  | "listPullRequestReviewThreads"
  | "getPullRequestReviewDraft"
  | "getPullRequestMetadata"
  | "listPullRequestChecks"
  | "listPullRequestCheckJobs"
  | "getPullRequestJobLog"
  | "listPullRequestCommits"
  | "listPullRequestFiles"
  | "getPullRequestDiff"
  | "watchPullRequest"
  | "preparePullRequestContext"
> {
  const read = async <T>(
    request: github.PullRequestPageRequest,
    kind: string,
    use: (scope: Awaited<ReturnType<typeof readScope>>) => Promise<T>,
  ) => {
    try {
      return await use(await readScope(core.github.prs, request, kind));
    } catch (cause) {
      throw githubFailure(cause);
    }
  };

  return {
    getPullRequestAvatar: async (r) => {
      try {
        return await pullRequestAvatar(core.github.prs, r);
      } catch (cause) {
        throw githubFailure(cause);
      }
    },
    listPullRequestTimeline: (r) => read(r, "timeline", timeline),
    listPullRequestReviewThreads: (r) => read(r, "reviews", reviewThreads),
    getPullRequestReviewDraft: (r) => read(r, "pending", reviewDraft),
    getPullRequestMetadata: (r) => read(r, "metadata", metadataPage),
    listPullRequestChecks: (r) => read(r, "checks", checks),
    listPullRequestCheckJobs: (r) => read(r, "jobs", jobs),
    getPullRequestJobLog: (r) => read(r, "log", jobLog),
    listPullRequestCommits: (r) => read(r, "commits", commits),
    listPullRequestFiles: (r) => read(r, "files", files),
    getPullRequestDiff: (r) => read(r, "diff", diff),
    watchPullRequest: (r, c) => watchPullRequest(core.github.prs, r, c.signal),
    preparePullRequestContext: async (r) => {
      try {
        return await prepareContext(core, r);
      } catch (cause) {
        throw githubFailure(cause);
      }
    },
  };
}
