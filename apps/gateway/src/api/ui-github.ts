import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { githubFailure } from "../github/http.ts";
import { githubClient } from "./github-client.ts";
import { uuid } from "../github/records.ts";

async function guard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw githubFailure(cause);
  }
}

function account(id: string) {
  if (!uuid(id)) throw new ConnectError("GitHub account not found", Code.NotFound);
}

export function githubHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listGitHubAccounts"
  | "beginGitHubDeviceAuth"
  | "getGitHubDeviceAuth"
  | "cancelGitHubDeviceAuth"
  | "disconnectGitHubAccount"
  | "useGitHubPat"
  | "listGitHubInstallations"
  | "listGitHubRepositories"
> {
  const binding = (value: string, context: HandlerContext) => githubClient(context, value);

  return {
    listGitHubAccounts: () => guard(() => core.github.list()),
    beginGitHubDeviceAuth: (r, c) =>
      guard(() => core.github.device.begin({ ...r, clientBinding: binding(r.clientBinding, c) })),
    getGitHubDeviceAuth: (r, c) => guard(() => core.github.device.get(r.attemptId, binding(r.clientBinding, c))),
    cancelGitHubDeviceAuth: (r, c) =>
      guard(() => core.github.device.get(r.attemptId, binding(r.clientBinding, c), true)),
    disconnectGitHubAccount: (r) =>
      guard(() => {
        account(r.accountId);

        return core.github.disconnect(r.accountId);
      }),
    useGitHubPat: (r) =>
      guard(() => {
        account(r.connectorAccountId);

        return core.github.usePat(r.connectorAccountId);
      }),
    listGitHubInstallations: (r) =>
      guard(() => {
        account(r.accountId);

        if (r.page > 200) throw new ConnectError("Choose a GitHub installation.", Code.InvalidArgument);

        return core.github.catalogue.installations(r);
      }),
    listGitHubRepositories: (r) =>
      guard(() => {
        account(r.accountId);

        if (!/^[1-9][0-9]{0,19}$/.test(r.installationId) || r.page > 200)
          throw new ConnectError("Choose a GitHub installation.", Code.InvalidArgument);

        return core.github.catalogue.repositories(r);
      }),
  };
}
