import type { GitHubAccounts } from "./service.ts";

/** Resolve a project grant before reading merge evidence and check it again after the upstream reads. */
export async function cleanupAccess(accounts: GitHubAccounts, project: string, name: string) {
  const { owner, run } = accounts;
  const grants = () => run((s) => s.cleanupRepositoryGrants(owner, project, name));

  for (const grant of await grants()) {
    const binding = () => accounts.agentBinding(grant.id, BigInt(grant.revision));
    const first = await binding().catch(() => undefined);

    if (first?.repositoryName.toLowerCase() !== name.toLowerCase()) continue;

    return {
      accountId: first.accountId,
      repositoryId: first.repositoryId,
      isCurrent: async () => {
        const current = await binding();

        return (
          current.accountRevision === first.accountRevision &&
          current.repositoryId === first.repositoryId &&
          current.accountId === first.accountId &&
          (await grants()).some((row) => row.id === grant.id && row.revision === grant.revision)
        );
      },
    };
  }

  const { mapping, row } = await accounts.prs.repositories.selected(name);
  const { connector_account_id: connectorId, connector_revision: revision } = row;

  if (row.auth_kind !== "pat" || !connectorId || revision === null) return;
  const granted = () => run((s) => s.detectionCleanupGrant(owner, connectorId, project, revision));

  if (!(await granted()).length) return;

  return {
    accountId: row.id,
    repositoryId: mapping.repository_id,
    isCurrent: async () => {
      const current = await accounts.prs.repositories.selected(name);

      return (
        current.row.id === row.id &&
        current.row.revision === row.revision &&
        current.mapping.revision === mapping.revision &&
        (await granted()).length > 0
      );
    },
  };
}
