import { github } from "@canopy/contracts";
import { toJson, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

const post = (operation: string, body: JsonBody) => requestJson("POST", `/api/github/${operation}`, body, 125_000);

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
