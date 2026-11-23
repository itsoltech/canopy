import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";
import { uuid } from "../agent-environment/composition.ts";
import { projectIds } from "../config-sync/project-aliases.ts";
import { fail, type AccountRow } from "./records.ts";

/** Grants use the shared project ID. A project can acquire a new canonical ID when it is linked. */
export function canonicalGrant(
  sql: SqlClient.SqlClient,
  owner: string | Statement.Fragment,
  id: string | Statement.Fragment,
) {
  return sql`COALESCE((
    SELECT ca.global_id FROM config_aliases ca WHERE ca.owner_user_id=${owner}::uuid
      AND ca.kind='project' AND ca.alias_id=${id}
  ), ${id})`;
}

export function projectConnectorAccess(
  sql: SqlClient.SqlClient,
  owner: string,
  projectId: string | null | Statement.Fragment,
  account: {
    id: string | Statement.Fragment;
    allProjects: boolean | Statement.Fragment;
    noProject?: boolean | Statement.Fragment;
  },
) {
  const project = canonicalGrant(sql, owner, sql`COALESCE(ci.global_id,p.id::text)`);
  const grant = canonicalGrant(sql, owner, sql`g.project_id::text`);

  return sql`EXISTS (
    SELECT 1 FROM projects p
    LEFT JOIN config_items ci ON ci.owner_user_id=p.owner_user_id AND ci.kind='project'
      AND ci.local_id=p.id::text AND ci.unsupported=''
    WHERE p.id=${projectId}::uuid AND p.owner_user_id=${owner}::uuid
      AND p.archived_at IS NULL AND NOT p.config_deleted
      AND ((p.kind='scratch' AND ${account.noProject ?? false}) OR
        (p.kind='project' AND (${account.allProjects} OR EXISTS (
          SELECT 1 FROM connector_project_grants g
          WHERE g.account_id=${account.id}::uuid AND ${grant}=${project}
        ))))
  )`;
}

export function replaceProjectAccess(
  sql: SqlClient.SqlClient,
  account: AccountRow,
  allProjects: boolean,
  requested: readonly string[],
) {
  return Effect.gen(function* () {
    if (requested.some((id) => !uuid(id))) return yield* fail("Choose projects from this account");
    const owner = account.owner_user_id;
    const ids = yield* projectIds(sql, owner);
    const localIds = [...new Set(requested.map((id) => ids.toLocal(id.toLowerCase())))];

    // Preserve already selected projects that are archived or whose shared record has yet to arrive.
    const existing = yield* sql<{ project_id: string }>`SELECT project_id FROM connector_project_grants
      WHERE account_id=${account.id}::uuid`;

    const allowed = new Set(existing.map((row) => ids.canonical(row.project_id)));

    const active = yield* sql<{ id: string }>`SELECT id FROM projects
      WHERE id=ANY(${localIds}::uuid[]) AND owner_user_id=${owner}::uuid
      AND kind='project' AND archived_at IS NULL AND NOT config_deleted FOR SHARE`;

    for (const row of active) allowed.add(ids.toGlobal(row.id));
    const grants = [...new Set(localIds.map(ids.toGlobal))];

    if (grants.some((id) => !uuid(id) || !allowed.has(id))) return yield* fail("Choose projects from this account");
    yield* sql`UPDATE connector_accounts SET all_projects=${allProjects} WHERE id=${account.id}::uuid`;
    yield* sql`DELETE FROM connector_project_grants WHERE account_id=${account.id}::uuid`;
    yield* sql`INSERT INTO connector_project_grants(account_id,project_id)
      SELECT ${account.id}::uuid,unnest(${grants}::uuid[])`;
  });
}
