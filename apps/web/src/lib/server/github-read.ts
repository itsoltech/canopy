import { github } from "@canopy/contracts";
import { readMessage } from "./body.ts";
import { gateway } from "./gateway.ts";
import { encode } from "#lib/shared/wire.ts";

export async function githubRead(api: ReturnType<typeof gateway>, operation: string, request: Request) {
  const options = { timeoutMs: 120_000 };

  switch (operation) {
    case "review-draft":
      return encode(
        github.PullRequestReviewDraftSchema,
        await api.getPullRequestReviewDraft(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "timeline":
      return encode(
        github.PullRequestTimelinePageSchema,
        await api.listPullRequestTimeline(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "reviews":
      return encode(
        github.PullRequestReviewThreadsPageSchema,
        await api.listPullRequestReviewThreads(
          await readMessage(request, github.PullRequestPageRequestSchema),
          options,
        ),
      );
    case "checks":
      return encode(
        github.PullRequestChecksPageSchema,
        await api.listPullRequestChecks(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "jobs":
      return encode(
        github.PullRequestJobsPageSchema,
        await api.listPullRequestCheckJobs(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "log":
      return encode(
        github.PullRequestJobLogPageSchema,
        await api.getPullRequestJobLog(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "commits":
      return encode(
        github.PullRequestCommitsPageSchema,
        await api.listPullRequestCommits(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "files":
      return encode(
        github.PullRequestFilesPageSchema,
        await api.listPullRequestFiles(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "diff":
      return encode(
        github.PullRequestDiffSchema,
        await api.getPullRequestDiff(await readMessage(request, github.PullRequestPageRequestSchema), options),
      );
    case "context":
      return encode(
        github.PullRequestContextResponseSchema,
        await api.preparePullRequestContext(
          await readMessage(request, github.PreparePullRequestContextRequestSchema),
          options,
        ),
      );
    case "update-account":
      return encode(
        github.GitHubUpdateAccountResponseSchema,
        await api.getGitHubUpdateAccount(await readMessage(request, github.GitHubAccountsRequestSchema), options),
      );
    case "set-update-account":
      return encode(
        github.GitHubUpdateAccountResponseSchema,
        await api.setGitHubUpdateAccount(await readMessage(request, github.GitHubUpdateAccountRequestSchema), options),
      );
    default:
      return undefined;
  }
}
