import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { fail, type AccountRow, type ExecutionSource } from "./records.ts";
import type { connectorSealing } from "./sealing.ts";
import { connectorId } from "../config-sync/connector-apply.ts";
import { connectorAccountViews } from "./account-views.ts";
import { projectConnectorAccess } from "./project-access.ts";

/** Owned accounts, their views and the grants that authorize a project or a bot. */
export function connectorAccounts(sql: SqlClient.SqlClient, sealing: ReturnType<typeof connectorSealing>) {
  const { view, views } = connectorAccountViews(sql, sealing);

  const owned = (user: string, id: string, lock = false) =>
    Effect.flatMap(connectorId(sql, user, id), (local) =>
      sql
        .unsafe<AccountRow>(
          `SELECT * FROM connector_accounts WHERE id=$1::uuid AND owner_user_id=$2::uuid${lock ? " FOR UPDATE" : ""}`,
          [local, user],
        )
        .pipe(Effect.flatMap((r) => (r[0] ? Effect.succeed(r[0]) : fail("Connector account not found")))),
    );

  const authorize = (source: ExecutionSource, connected = true) =>
    Effect.gen(function* () {
      const account = yield* owned(source.userId, source.accountId);

      if (connected && account.status !== "connected")
        return yield* fail("Connector needs reconnect or is disconnected");

      if (source.threadId) {
        const allowed = yield* sql`SELECT 1 FROM threads t JOIN workers w ON w.id=t.worker_id
          JOIN connector_accounts a ON a.id=${account.id}::uuid AND a.revision=${account.revision}::bigint
          WHERE t.id=${source.threadId}::uuid AND t.owner_user_id=${source.userId}::uuid
          AND t.runtime='worker' AND t.archived_at IS NULL AND t.deleted_at IS NULL
          AND w.id=${source.workerId ?? null}::uuid AND w.revoked_at IS NULL AND w.archived_at IS NULL
          AND (w.owner_user_id=${source.userId}::uuid OR w.owner_user_id IS NULL)
          AND ${projectConnectorAccess(sql, source.userId, sql`t.project_id`, {
            id: sql`a.id`,
            allProjects: sql`a.all_projects`,
            noProject: sql`a.no_project`,
          })}`;

        if (!allowed.length) return yield* fail("Connector access denied");
      } else if (source.botId) {
        const bot =
          yield* sql`SELECT id FROM bots WHERE id=${source.botId}::uuid AND owner_user_id=${source.userId}::uuid AND deleted_at IS NULL AND archived_at IS NULL`;

        const grant =
          yield* sql`SELECT 1 FROM connector_bot_grants WHERE account_id=${account.id}::uuid AND bot_id=${source.botId}::uuid`;

        if (!bot.length || (!account.all_bots && !grant.length)) return yield* fail("Connector access denied");
      } else return yield* fail("Connector access denied");

      return account;
    });

  const list = (
    user: string,
    scope: { projectId?: string; threadId?: string; workerId?: string; botId?: string; connectorType?: string } = {},
    metadataOnly = false,
  ) =>
    Effect.gen(function* () {
      let projectId = scope.projectId;

      if (scope.threadId) {
        const row = (yield* sql<{
          project_id: string;
        }>`SELECT project_id FROM threads WHERE id=${scope.threadId}::uuid
          AND owner_user_id=${user}::uuid AND deleted_at IS NULL AND runtime='worker'`)[0];

        if (!row) return yield* fail("Thread not found");
        projectId = row.project_id;
      }

      if (
        scope.botId &&
        !(yield* sql`SELECT id FROM bots WHERE id=${scope.botId}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)
          .length
      )
        return yield* fail("Bot not found");

      const rows =
        yield* sql<AccountRow>`SELECT a.id,a.owner_user_id,a.connector_type,a.name,a.namespace,a.url,a.transport,
      a.auth_kind,a.credentials,a.legacy_headers,a.status,a.error,a.all_projects,a.no_project,a.all_bots,a.revision,a.last_used_at,
      ${metadataOnly ? sql`'[]'::jsonb` : sql`a.tools`} AS tools
      FROM connector_accounts a WHERE owner_user_id=${user}::uuid
      AND (${scope.connectorType ?? null}::text IS NULL OR a.connector_type=${scope.connectorType ?? null})
      AND ${
        projectId
          ? projectConnectorAccess(sql, user, projectId, {
              id: sql`a.id`,
              allProjects: sql`a.all_projects`,
              // Only thread catalogs use the scratch scope. Project-only reads also back worktree cleanup.
              noProject: scope.threadId || scope.workerId ? sql`a.no_project` : false,
            })
          : sql`true`
      }
      AND (${scope.botId ?? null}::uuid IS NULL OR (a.all_bots OR EXISTS(SELECT 1 FROM connector_bot_grants g WHERE g.account_id=a.id AND g.bot_id=${scope.botId ?? null}::uuid)))
      ORDER BY connector_type, name, id`;

      return rows;
    });

  const audit = (
    source: ExecutionSource,
    tool: string,
    outcome: string,
  ) => sql`INSERT INTO connector_audit(account_id,owner_user_id,worker_id,thread_id,bot_id,tool,outcome)
    VALUES (${source.accountId}::uuid,${source.userId}::uuid,${source.workerId ?? null}::uuid,${source.threadId ?? null}::uuid,${source.botId ?? null}::uuid,${tool.slice(0, 128)},${outcome})`;

  return { owned, view, views, authorize, list, audit };
}

export type ConnectorBase = ReturnType<typeof connectorSealing> & ReturnType<typeof connectorAccounts>;
