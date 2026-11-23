import { ConnectorToolSchema, ui } from "@canopy/contracts";
import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConnectorBase } from "./accounts.ts";
import { fail } from "./records.ts";
import { connectorTransaction } from "../config-sync/connector-records.ts";
import { connectorType } from "./catalog.ts";
import { connectorSessionState } from "./session-state.ts";
import { linkedMessengerActive } from "../messengers/linked-account.ts";
import { connectorToolCatalog } from "./slack-post-tool.ts";
import { projectIds } from "../config-sync/project-aliases.ts";
import { canonicalGrant, projectConnectorAccess } from "./project-access.ts";

/** Read no credential-bearing columns, including when the account is disconnected. */
export function threadConnectorList(
  sql: SqlClient.SqlClient,
  user: string,
  worker: string,
  project: string,
  threadId: string,
) {
  return sql<{
    id: string;
    connector_type: string;
    auth_kind: string;
    name: string;
    namespace: string;
    status: string;
    all_projects: boolean;
    revision: string;
    granted: boolean;
    slack_post: boolean;
    slack_download: boolean;
    tools: JsonValue[];
  }>`
    SELECT c.id,c.connector_type,c.auth_kind,c.name,c.namespace,c.status,c.all_projects,c.revision::text,c.tools,
      ${projectConnectorAccess(sql, user, worker ? project : null, {
        id: sql`c.id`,
        allProjects: sql`c.all_projects`,
        noProject: sql`c.no_project`,
      })} AS granted,
      c.connector_type='slack' AND EXISTS(SELECT 1 FROM messenger_accounts a
        WHERE a.connector_account_id=c.id AND a.owner_user_id=c.owner_user_id AND a.enabled AND a.deleted_at IS NULL
          AND ${linkedMessengerActive(sql)}) AS slack_post,
      EXISTS(SELECT 1 FROM workers w WHERE w.id=${worker || null}::uuid
        AND w.capabilities->>'agentToolAttachments'='true' AND coalesce(w.capabilities->>'attachmentsRoot','')<>'') AS slack_download
    FROM connector_accounts c WHERE c.owner_user_id=${user}::uuid ORDER BY c.connector_type,c.name,c.id`.pipe(
    Effect.flatMap((rows) =>
      connectorSessionState(
        sql,
        threadId,
        rows.map((row) =>
          create(ui.ThreadConnectorSchema, {
            accountId: row.id,
            connectorName: connectorType(row.connector_type)?.name ?? row.connector_type,
            accountLabel: row.name,
            status: row.status,
            granted: row.granted,
            allProjects: row.all_projects,
            revision: BigInt(row.revision),
          }),
        ),
        rows.flatMap((row) =>
          row.granted && row.status === "connected"
            ? connectorToolCatalog(
                row,
                row.tools.map((tool) => fromJson(ConnectorToolSchema, tool)),
                row.slack_post,
                row.slack_download,
              )
            : [],
        ),
      ),
    ),
  );
}

/** Edit the thread's project grant under the same account lock as account-wide edits. */
export function threadConnectorGrant(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  return (user: string, request: ui.SetThreadConnectorGrantRequest) =>
    connectorTransaction(
      sql,
      key,
      Effect.gen(function* () {
        if (!request.projectScope) return yield* fail("Update Canopy to change project access");

        const threads = yield* sql<{
          worker_id: string;
          project_id: string;
        }>`SELECT t.worker_id,t.project_id FROM threads t
        JOIN projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id WHERE t.id=${request.threadId}::uuid
        AND t.owner_user_id=${user}::uuid AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.runtime='worker' AND p.kind='project' AND p.archived_at IS NULL AND NOT p.config_deleted FOR SHARE OF t,p`;

        const thread = threads[0];

        if (!thread) return yield* fail("Choose a thread in an active project");
        const account = yield* base.owned(user, request.accountId, true);

        if (BigInt(account.revision) !== request.expectedRevision)
          return yield* fail("Connector changed; reload and try again");

        if (account.all_projects) return yield* fail("Change access for all projects in Settings → Connectors");
        const ids = yield* projectIds(sql, user);
        const project = ids.toGlobal(thread.project_id);

        if (request.granted)
          yield* sql`INSERT INTO connector_project_grants(account_id,project_id)
          VALUES(${account.id}::uuid,${project}::uuid) ON CONFLICT DO NOTHING`;
        else
          yield* sql`DELETE FROM connector_project_grants g WHERE account_id=${account.id}::uuid
          AND ${canonicalGrant(sql, user, sql`g.project_id::text`)}=${project}`;
        yield* sql`UPDATE connector_accounts SET revision=revision+1,updated_at=now() WHERE id=${account.id}::uuid`;
        yield* base.audit(
          { userId: user, accountId: account.id, threadId: request.threadId, workerId: thread.worker_id },
          "access",
          request.granted ? "granted" : "revoked",
        );
      }),
    );
}
