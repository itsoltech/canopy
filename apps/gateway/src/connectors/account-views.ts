import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { connectors } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";
import type { connectorSealing } from "./sealing.ts";
import { canonicalGrant } from "./project-access.ts";

export function connectorAccountViews(sql: SqlClient.SqlClient, sealing: ReturnType<typeof connectorSealing>) {
  const { unseal } = sealing;

  const render = (row: AccountRow, projects: string[], bots: string[]) =>
    create(connectors.ConnectorAccountSchema, {
      id: row.id,
      connectorType: row.connector_type,
      name: row.name,
      namespace: row.namespace,
      url: row.url,
      transport: row.transport,
      authKind: row.auth_kind,
      status: row.status,
      ...(row.status === "error" && row.error && { error: fromJson(connectors.ConnectorErrorSchema, row.error) }),
      allProjects: row.all_projects,
      projectIds: projects,
      noProject: row.no_project,
      allBots: row.all_bots,
      botIds: bots,
      revision: BigInt(row.revision),
      ...(row.last_used_at && { lastUsedAt: timestampFromDate(new Date(row.last_used_at)) }),
      headerNames: [...new Set([...Object.keys(unseal(row).headers ?? {}), ...Object.keys(row.legacy_headers)])],
    });

  const views = (rows: readonly AccountRow[]) =>
    Effect.gen(function* () {
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id);

      const projects = yield* sql<{ account_id: string; id: string }>`SELECT g.account_id,
        COALESCE(NULLIF(c.local_id,''),g.project_id::text) AS id
      FROM connector_project_grants g JOIN connector_accounts a ON a.id=g.account_id
      LEFT JOIN config_items c ON c.owner_user_id=a.owner_user_id AND c.kind='project' AND c.unsupported=''
        AND c.global_id=${canonicalGrant(sql, sql`a.owner_user_id`, sql`g.project_id::text`)}
      WHERE g.account_id=ANY(${ids}::uuid[]) ORDER BY g.account_id,g.project_id`;

      const bots = yield* sql<{ account_id: string; id: string }>`SELECT g.account_id,g.bot_id AS id
      FROM connector_bot_grants g JOIN bots b ON b.id=g.bot_id
      WHERE g.account_id=ANY(${ids}::uuid[]) AND b.deleted_at IS NULL ORDER BY g.account_id,g.bot_id`;

      const projectGroups = Map.groupBy(projects, (grant) => grant.account_id);
      const botGroups = Map.groupBy(bots, (grant) => grant.account_id);

      return rows.map((row) => {
        const projectIds = [...new Set(projectGroups.get(row.id)?.map(({ id }) => id))];
        const botIds = botGroups.get(row.id)?.map(({ id }) => id) ?? [];

        return render(row, projectIds, botIds);
      });
    });

  const view = (row: AccountRow) => views([row]).pipe(Effect.map((rows) => rows[0]!));

  return { view, views };
}
