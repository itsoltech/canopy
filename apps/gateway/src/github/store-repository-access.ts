import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";

export interface RepositoryAccessRow extends AccountRow {
  repository_id: string;
  repository_name: string;
}

export function githubRepositoryAccess(sql: SqlClient.SqlClient) {
  return {
    connectedGitHubAccounts: (owner: string) => sql<AccountRow>`SELECT * FROM github_accounts
      WHERE owner_user_id=${owner}::uuid AND status='connected' ORDER BY id`,
    repositoryAccess: (owner: string, name: string) => sql<RepositoryAccessRow>`
      SELECT DISTINCT a.*,r.repository_id,r.full_name AS repository_name
      FROM github_installation_repositories r
      JOIN github_installations i USING(owner_user_id,account_id,installation_id)
      JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id
      WHERE r.owner_user_id=${owner}::uuid AND lower(r.full_name)=lower(${name})
        AND a.status='connected' AND a.auth_kind='device' AND NOT i.suspended
      UNION
      SELECT a.*,m.repository_id,m.repository_name FROM github_repository_accounts m
      JOIN github_accounts a ON a.owner_user_id=m.owner_user_id AND a.id=m.account_id
      WHERE m.owner_user_id=${owner}::uuid AND lower(m.repository_name)=lower(${name})
        AND a.status='connected' AND a.auth_kind='pat'`,
  };
}
