import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { notFound, uuid } from "./records.ts";
import { repositoryName } from "./repository-accounts.ts";
import type { GitHubAccounts } from "./service.ts";
import { agentAccessConflict, expandsAgentAccess } from "./store-agent-access.ts";

function validateRepository(request: { accountId: string; repositoryName: string; repositoryId: string }) {
  if (!uuid(request.accountId)) throw notFound();
  repositoryName(request.repositoryName);

  if (!/^[1-9][0-9]{0,19}$/.test(request.repositoryId))
    throw new ConnectError("Choose a GitHub repository.", Code.InvalidArgument);
}

export function getAgentAccess(accounts: GitHubAccounts, request: github.GetGitHubAgentAccessRequest) {
  validateRepository(request);

  return accounts.run((store) => store.agentAccess(accounts.owner, request));
}

export async function setAgentAccess(accounts: GitHubAccounts, request: github.SetGitHubAgentAccessRequest) {
  validateRepository(request);

  for (const ids of [request.botIds, request.projectIds]) {
    if (ids.length > 256 || ids.some((id) => !uuid(id)))
      throw new ConnectError("Choose up to 256 projects or bots from this account.", Code.InvalidArgument);
  }

  const current = await accounts.run((store) => store.agentAccess(accounts.owner, request));

  if (current.revision !== request.expectedRevision) throw agentAccessConflict();

  // Removing access must work even after disconnect, uninstall, or an upstream outage.
  if (expandsAgentAccess(request, current)) await accounts.catalogue.refresh(request.accountId, true);

  return accounts.run((store) => store.setAgentAccess(accounts.owner, request));
}

/** Reads the caller's exact connector revision, refreshed installation, and current product preference. */
export async function agentBinding(accounts: GitHubAccounts, connectorId: string, expectedRevision: bigint) {
  const unavailable = () =>
    new ConnectError("GitHub agent access to this repository is unavailable.", Code.PermissionDenied);

  if (!uuid(connectorId)) throw unavailable();
  const { run, owner } = accounts;
  const local = (await run((store) => store.agentConnector(owner, connectorId, expectedRevision)))[0];

  if (!local) throw unavailable();
  const accountId = local.github_account_id;
  await accounts.catalogue.refresh(accountId);
  const bound = (await run((store) => store.agentBinding(owner, accountId, connectorId, expectedRevision)))[0];

  if (!bound) throw unavailable();

  return {
    accountId,
    repositoryId: bound.repository_id,
    repositoryName: repositoryName(bound.full_name),
    accountRevision: BigInt(bound.account_revision),
    allowWrites: bound.github_allow_writes,
  };
}
