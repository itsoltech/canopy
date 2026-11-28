import type { SqlClient, Statement } from "effect/sql";

/** A missing product preference is allowed. A different selection is never changed by agent access. */
export function installedRepositories(sql: SqlClient.SqlClient, owner: string, account: string | Statement.Fragment) {
  return sql`SELECT r.repository_id,r.full_name,NOT EXISTS (
      SELECT FROM github_repository_accounts m WHERE m.owner_user_id=r.owner_user_id
        AND (m.repository_id=r.repository_id OR lower(m.repository_name)=lower(r.full_name))
        AND (m.account_id<>r.account_id OR m.repository_id<>r.repository_id)
    ) AS selected
    FROM github_installation_repositories r JOIN github_installations i USING(owner_user_id,account_id,installation_id)
    JOIN github_accounts ga ON ga.owner_user_id=r.owner_user_id AND ga.id=r.account_id
    WHERE r.owner_user_id=${owner}::uuid AND r.account_id=${account}::uuid
      AND NOT i.suspended AND ga.catalog_verified_at IS NOT NULL AND ga.status='connected' AND ga.auth_kind='device'`;
}

/** Shared by worker/bot tool discovery and the thread panel. Legacy connector catalogs are independent. */
export function availableConnector(sql: SqlClient.SqlClient, owner: string, alias: "a" | "c") {
  const account = sql(alias);

  return sql`(${account}.connector_type<>'github_repository' OR EXISTS (
    SELECT FROM (${installedRepositories(sql, owner, sql`${account}.github_account_id`)}) installed
    WHERE installed.repository_id=${account}.github_repository_id AND installed.selected
  ))`;
}
