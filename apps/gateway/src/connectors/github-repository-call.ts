import type { JsonValue } from "@bufbuild/protobuf";
import type { ConnectorTool } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { githubFailure, GitHubHttpFailure } from "../github/http.ts";
import { repositoryName } from "../github/repository-accounts.ts";
import { Repository } from "../github/schemas.ts";
import type { GitHubAccounts } from "../github/service.ts";
import { redactConnector } from "./oauth.ts";
import type { AccountRow } from "./records.ts";
import { githubRepositoryRequest, GitHubToolFailure } from "./github-repository-tools.ts";
import { githubRepositoryResult } from "./github-repository-result.ts";

export type GitHubToolScope = Awaited<ReturnType<GitHubAccounts["agentBinding"]>>;

export async function prepareGitHubCall(
  accounts: GitHubAccounts,
  scope: GitHubToolScope,
  account: AccountRow,
  tool: ConnectorTool,
  args: JsonObject,
  signal: AbortSignal,
  authorize: () => Promise<AccountRow>,
) {
  const request = githubRepositoryRequest(tool.remoteName, args);
  const revision = BigInt(account.revision);
  const binding = () => accounts.agentBinding(account.id, revision);

  if (request.body && !scope.allowWrites) throw new GitHubToolFailure("This GitHub repository grant is read-only.");
  const name = repositoryName(scope.repositoryName);

  // A name may have transferred or been reused. Address all subsequent operations by the verified numeric ID.
  const { value: access } = await accounts.access.authorized(scope.accountId, async (token) => {
    if (BigInt(token.row.revision) !== scope.accountRevision)
      throw new GitHubToolFailure("GitHub access changed. Check the repository before requesting this action again.");

    const repo = Schema.decodeUnknownSync(Repository)(
      await accounts.http.get(`/repos/${name}`, token.token, signal, token.secrets),
    );

    if (String(repo.id) !== scope.repositoryId || repo.full_name.toLowerCase() !== name.toLowerCase())
      throw new GitHubToolFailure("This repository changed. Check its agent access in Settings → GitHub.");

    return token;
  });

  const checkAccess = async () => {
    const current = await authorize();

    if (BigInt(current.revision) !== revision) throw new GitHubToolFailure("The repository grant changed.");
    const checked = await binding();

    if (
      checked.accountId !== scope.accountId ||
      checked.accountRevision !== scope.accountRevision ||
      checked.repositoryId !== scope.repositoryId ||
      checked.repositoryName !== name ||
      (request.body && !checked.allowWrites)
    )
      throw new GitHubToolFailure("Access to this GitHub repository changed.");
  };

  const path = `/repositories/${scope.repositoryId}${request.path}`;
  const secrets = [access.token, ...(access.secrets ?? [])];

  const send = async (): Promise<JsonValue> => {
    try {
      const data = await accounts.http.request(
        path,
        {
          method: request.body ? "POST" : "GET",
          signal,
          headers: {
            Authorization: `Bearer ${access.token}`,
            ...(request.body && { "Content-Type": "application/json" }),
          },
          ...(request.body && { body: JSON.stringify(request.body) }),
        },
        secrets,
      );

      await checkAccess();
      const result = githubRepositoryResult(name, request, data, secrets);

      return { content: [{ type: "text", text: redactConnector(JSON.stringify(result), {}, secrets) }] };
    } catch (cause) {
      let message: string;

      if (cause instanceof GitHubToolFailure) message = cause.message;
      else if (cause instanceof GitHubHttpFailure && cause.status === 401)
        message = "GitHub rejected this account. Reconnect it in Settings → GitHub.";
      else if (cause instanceof GitHubHttpFailure && cause.status === 422)
        message = "GitHub rejected the arguments. Check the issue or branch names and the requested change.";
      else if (cause instanceof GitHubHttpFailure && cause.status < 500) message = githubFailure(cause).rawMessage;
      else if (request.body) message = "The GitHub write outcome is unknown. Check the repository before trying again.";
      else message = "The GitHub read failed or repository access changed. Check the grant and try again.";

      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };

  return { checkAccess, send };
}
