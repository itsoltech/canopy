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

/** Read no credential-bearing columns, including when the account is disconnected. */
export function threadConnectorList(sql: SqlClient.SqlClient, user: string, worker: string, threadId: string) {
  return sql<{
    id: string;
    connector_type: string;
    auth_kind: string;
    name: string;
    namespace: string;
    status: string;
    all_workers: boolean;
    revision: string;
    granted: boolean;
    slack_post: boolean;
    slack_download: boolean;
    tools: JsonValue[];
  }>`
    SELECT c.id,c.connector_type,c.auth_kind,c.name,c.namespace,c.status,c.all_workers,c.revision::text,c.tools,
      c.all_workers OR EXISTS(SELECT 1 FROM connector_worker_grants g
        WHERE g.account_id=c.id AND g.worker_id=${worker || null}::uuid) AS granted,
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
            allWorkers: row.all_workers,
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

/** Change only this thread's worker grant, under the same account lock as account-wide edits. */
export function threadConnectorGrant(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  return (user: string, request: ui.SetThreadConnectorGrantRequest) =>
    connectorTransaction(
      sql,
      key,
      Effect.gen(function* () {
        const threads = yield* sql<{ worker_id: string }>`SELECT t.worker_id FROM threads t
        JOIN workers w ON w.id=t.worker_id WHERE t.id=${request.threadId}::uuid
        AND t.owner_user_id=${user}::uuid AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND (w.owner_user_id=${user}::uuid OR w.owner_user_id IS NULL)
        AND w.archived_at IS NULL AND w.revoked_at IS NULL FOR SHARE OF t,w`;

        const thread = threads[0];

        if (!thread) return yield* fail("Thread or worker not found");
        const account = yield* base.owned(user, request.accountId, true);

        if (BigInt(account.revision) !== request.expectedRevision)
          return yield* fail("Connector changed; reload and try again");

        if (account.all_workers) return yield* fail("Manage access for all workers on the home computer");

        if (request.granted)
          yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id)
          VALUES(${account.id}::uuid,${thread.worker_id}::uuid) ON CONFLICT DO NOTHING`;
        else
          yield* sql`DELETE FROM connector_worker_grants WHERE account_id=${account.id}::uuid
          AND worker_id=${thread.worker_id}::uuid`;
        yield* sql`UPDATE connector_accounts SET revision=revision+1,updated_at=now() WHERE id=${account.id}::uuid`;
        yield* base.audit(
          { userId: user, accountId: account.id, threadId: request.threadId, workerId: thread.worker_id },
          "access",
          request.granted ? "granted" : "revoked",
        );
      }),
    );
}
