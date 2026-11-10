import { github } from "@canopy/contracts";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

const post = (operation: string, body: JsonBody) => requestJson("POST", `/api/github/${operation}`, body, 125_000);

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
