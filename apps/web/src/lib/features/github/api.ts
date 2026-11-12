import { github } from "@canopy/contracts";
import { toJson, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import type { MutationApi } from "@canopy/domain/github-mutations";
import { importPullRequestDraft } from "@canopy/domain/github-lifecycle";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";

const post = (operation: string, body: JsonBody) => requestJson("POST", `/api/github/${operation}`, body, 125_000);

const mutate = async (operation: string, r: github.PullRequestMutationRequest) =>
  decode(
    github.PullRequestMutationReceiptSchema,
    await post(operation, toJson(github.PullRequestMutationRequestSchema, r)),
  );

export const mutations: MutationApi = {
  rerunPullRequestChecks: (r) => mutate("rerun-checks", r),
  cancelPullRequestCheckRun: (r) => mutate("cancel-run", r),
  updatePullRequestDetails: (r) => mutate("update-details", r),
  requestPullRequestReviewers: (r) => mutate("request-reviewers", r),
  setPullRequestAssignees: (r) => mutate("set-assignees", r),
  setPullRequestLabels: (r) => mutate("set-labels", r),
  createPullRequest: (r) => mutate("create-pr", r),
  setPullRequestDraft: (r) => mutate("set-draft", r),
  mergePullRequest: (r) => mutate("merge", r),
  setPullRequestQueue: (r) => mutate("queue", r),
  setPullRequestAutoMerge: (r) => mutate("auto-merge", r),
  updatePullRequestBranch: (r) => mutate("update-branch", r),
  setPullRequestOpen: (r) => mutate("set-open", r),
  preparePullRequestMutation: (r) => mutate("prepare-mutation", r),
  getPullRequestMutation: async (r) =>
    decode(
      github.PullRequestMutationReceiptSchema,
      await post("mutation", toJson(github.PullRequestMutationRequestRefSchema, r)),
    ),
  createPullRequestComment: (r) => mutate("create-comment", r),
  replyPullRequestReviewThread: (r) => mutate("reply", r),
  updatePullRequestComment: (r) => mutate("update-comment", r),
  deletePullRequestComment: (r) => mutate("delete-comment", r),
  setPullRequestFileViewed: (r) => mutate("viewed", r),
  addPullRequestReviewComment: (r) => mutate("add-review-comment", r),
  submitPullRequestReview: (r) => mutate("submit-review", r),
  discardPullRequestReview: (r) => mutate("discard-review", r),
  setPullRequestReviewThreadResolved: (r) => mutate("resolve-thread", r),
};

export const createContext = async (r: github.PullRequestCreateContextRequest) =>
  decode(
    github.PullRequestCreateContextSchema,
    await post("create-context", toJson(github.PullRequestCreateContextRequestSchema, r)),
  );

export const draftContext = async (r: github.PullRequestCreateContextRequest) =>
  decode(
    github.PullRequestContextResponseSchema,
    await post("draft-context", toJson(github.PullRequestCreateContextRequestSchema, r)),
  );

export const agentDraft = async (r: github.PullRequestCreateContextRequest) =>
  importPullRequestDraft(
    JSON.stringify(await post("agent-draft", toJson(github.PullRequestCreateContextRequestSchema, r))),
  );

export const page = async <D extends DescMessage>(
  operation: string,
  schema: D,
  request: github.PullRequestPageRequest,
): Promise<MessageShape<D>> =>
  decode(schema, await post(operation, toJson(github.PullRequestPageRequestSchema, request)));

export const context = async (request: github.PreparePullRequestContextRequest) =>
  decode(
    github.PullRequestContextResponseSchema,
    await post("context", toJson(github.PreparePullRequestContextRequestSchema, request)),
  );

export const updateAccount = async (homeId: string) =>
  decode(github.GitHubUpdateAccountResponseSchema, await post("update-account", { homeId }));

export const setUpdateAccount = async (homeId: string, accountId: string, enabled: boolean) =>
  decode(github.GitHubUpdateAccountResponseSchema, await post("set-update-account", { homeId, accountId, enabled }));

export const accounts = async (homeId: string) =>
  decode(github.GitHubAccountsResponseSchema, await post("accounts", { homeId }));

export const begin = async (homeId: string, clientRequestId: string) =>
  decode(github.GitHubDeviceAuthResponseSchema, await post("begin", { homeId, clientRequestId }));

export const status = async (attemptId: string) =>
  decode(github.GitHubDeviceAuthResponseSchema, await post("status", { attemptId }));

export const cancel = async (attemptId: string) =>
  decode(github.GitHubDeviceAuthResponseSchema, await post("cancel", { attemptId }));

export const disconnect = async (accountId: string) =>
  decode(github.GitHubAccountResponseSchema, await post("disconnect", { accountId }));

export const usePat = async (homeId: string, connectorAccountId: string) =>
  decode(github.GitHubAccountResponseSchema, await post("pat", { homeId, connectorAccountId }));

export const installations = async (accountId: string, page = 0, refresh = false) =>
  decode(github.GitHubInstallationsResponseSchema, await post("installations", { accountId, page, refresh }));

export const repositories = async (accountId: string, installationId: string, page = 0) =>
  decode(github.GitHubRepositoriesResponseSchema, await post("repositories", { accountId, installationId, page }));

export const repositoryAccount = async (homeId: string, repositoryName: string) =>
  decode(github.GitHubRepositoryAccountResponseSchema, await post("repository-account", { homeId, repositoryName }));

export const chooseAccount = async (
  homeId: string,
  repositoryName: string,
  accountId: string,
  expectedRevision: bigint,
) =>
  decode(
    github.GitHubRepositoryAccountResponseSchema,
    await post("choose-account", { homeId, repositoryName, accountId, expectedRevision: String(expectedRevision) }),
  );

export const pullRequests = async (threadId: string) =>
  decode(github.ThreadPullRequestsResponseSchema, await post("pull-requests", { threadId }));

export const repositoryPullRequests = async (threadId: string, query = "", includeClosed = false, cursor = "") => {
  const read = async () =>
    decode(
      github.RepositoryPullRequestsResponseSchema,
      await post("repository-pull-requests", { threadId, query, includeClosed, cursor }),
    );
  const value = await read();
  const candidate = value.selection?.candidates.find((account) => account.authKind === "device");
  if (cursor || value.state !== "choose_account" || !candidate || !value.selection) return value;
  const node = splitId(threadId).node;
  // Opening the picker remembers its best available account; the top switcher can change it.
  await chooseAccount(
    node ? `${GITHUB_HOME}~${node}` : "",
    value.repositoryName,
    candidate.id,
    value.selection.revision,
  ).catch(() => {});

  return read();
};

export const link = async (threadId: string, url: string, expectedRevision: bigint) =>
  decode(
    github.ThreadPullRequestsResponseSchema,
    await post("link", { threadId, url, expectedRevision: String(expectedRevision) }),
  );

export const unlink = async (threadId: string, pullRequestId: string, expectedRevision: bigint) =>
  decode(
    github.ThreadPullRequestsResponseSchema,
    await post("unlink", { threadId, pullRequestId, expectedRevision: String(expectedRevision) }),
  );

export const pullRequest = async (pullRequestId: string, refresh = false) =>
  decode(github.PullRequestSnapshotSchema, await post("pull-request", { pullRequestId, refresh }));
