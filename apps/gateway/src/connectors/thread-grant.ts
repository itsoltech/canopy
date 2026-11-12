import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConnectorBase } from "./accounts.ts";
import { fail } from "./records.ts";
import { connectorTransaction } from "../config-sync/connector-records.ts";
import { connectorType } from "./catalog.ts";

/** Read no credential-bearing columns, including when the account is disconnected. */
export function threadConnectorList(sql: SqlClient.SqlClient, user: string, worker: string) {
  return sql<{
    id: string;
    connector_type: string;
    name: string;
    status: string;
    all_workers: boolean;
    revision: string;
    granted: boolean;
  }>`
    SELECT a.id,a.connector_type,a.name,a.status,a.all_workers,a.revision::text,
      a.all_workers OR EXISTS(SELECT 1 FROM connector_worker_grants g
        WHERE g.account_id=a.id AND g.worker_id=${worker || null}::uuid) AS granted
    FROM connector_accounts a WHERE a.owner_user_id=${user}::uuid ORDER BY a.connector_type,a.name,a.id`.pipe(
    Effect.map((rows) =>
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
