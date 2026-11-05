import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { connectors } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { fail, type AccountRow, type ExecutionSource } from "./records.ts";
import type { connectorSealing } from "./sealing.ts";
import { connectorId } from "../config-sync/connector-apply.ts";

/** Owned accounts, their views and the grants that authorize a worker thread or a bot. */
export function connectorAccounts(sql: SqlClient.SqlClient, sealing: ReturnType<typeof connectorSealing>) {
  const { unseal } = sealing;

  const owned = (user: string, id: string, lock = false) =>
    Effect.flatMap(connectorId(sql, user, id), (local) =>
      sql
        .unsafe<AccountRow>(
          `SELECT * FROM connector_accounts WHERE id=$1::uuid AND owner_user_id=$2::uuid${lock ? " FOR UPDATE" : ""}`,
          [local, user],
        )
        .pipe(Effect.flatMap((r) => (r[0] ? Effect.succeed(r[0]) : fail("Connector account not found")))),
    );

  const view = (row: AccountRow) =>
    Effect.gen(function* () {
      const workers = yield* sql<{
        worker_id: string;
      }>`SELECT worker_id FROM connector_worker_grants WHERE account_id=${row.id}::uuid`;

      const bots = yield* sql<{
        bot_id: string;
      }>`SELECT bot_id FROM connector_bot_grants WHERE account_id=${row.id}::uuid`;

      return create(connectors.ConnectorAccountSchema, {
        id: row.id,
        connectorType: row.connector_type,
        name: row.name,
        namespace: row.namespace,
        url: row.url,
        transport: row.transport,
        authKind: row.auth_kind,
        status: row.status,
        ...(row.status === "error" && row.error && { error: fromJson(connectors.ConnectorErrorSchema, row.error) }),
        allWorkers: row.all_workers,
        workerIds: workers.map((w) => w.worker_id),
        allBots: row.all_bots,
        botIds: bots.map((b) => b.bot_id),
        revision: BigInt(row.revision),
        ...(row.last_used_at && { lastUsedAt: timestampFromDate(new Date(row.last_used_at)) }),
        headerNames: [...new Set([...Object.keys(unseal(row).headers ?? {}), ...Object.keys(row.legacy_headers)])],
      });
    });

  const authorize = (source: ExecutionSource, connected = true) =>
    Effect.gen(function* () {
      const account = yield* owned(source.userId, source.accountId);

      if (connected && account.status !== "connected")
        return yield* fail("Connector needs reconnect or is disconnected");

      if (source.threadId) {
        const thread = (yield* sql<{
          worker_id: string;
        }>`SELECT worker_id FROM threads WHERE id=${source.threadId}::uuid
        AND owner_user_id=${source.userId}::uuid AND runtime='worker' AND archived_at IS NULL AND deleted_at IS NULL`)[0];

        if (!thread || thread.worker_id !== source.workerId) return yield* fail("Connector access denied");

        const worker =
          yield* sql`SELECT id FROM workers WHERE id=${thread.worker_id}::uuid AND revoked_at IS NULL AND archived_at IS NULL
        AND (owner_user_id=${source.userId}::uuid OR owner_user_id IS NULL)`;

        const grant =
          yield* sql`SELECT 1 FROM connector_worker_grants WHERE account_id=${account.id}::uuid AND worker_id=${thread.worker_id}::uuid`;

        if (!worker.length || (!account.all_workers && !grant.length)) return yield* fail("Connector access denied");
      } else if (source.botId) {
        const bot =
          yield* sql`SELECT id FROM bots WHERE id=${source.botId}::uuid AND owner_user_id=${source.userId}::uuid AND deleted_at IS NULL AND archived_at IS NULL`;

        const grant =
          yield* sql`SELECT 1 FROM connector_bot_grants WHERE account_id=${account.id}::uuid AND bot_id=${source.botId}::uuid`;

        if (!bot.length || (!account.all_bots && !grant.length)) return yield* fail("Connector access denied");
      } else return yield* fail("Connector access denied");

      return account;
    });

  const list = (user: string, scope: { workerId?: string; threadId?: string; botId?: string } = {}) =>
    Effect.gen(function* () {
      let workerId = scope.workerId;

      if (scope.threadId) {
        const row = (yield* sql<{
          worker_id: string;
        }>`SELECT worker_id FROM threads WHERE id=${scope.threadId}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)[0];

        if (!row) return yield* fail("Thread not found");
        workerId = row.worker_id;
      }

      if (
        scope.botId &&
        !(yield* sql`SELECT id FROM bots WHERE id=${scope.botId}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)
          .length
      )
        return yield* fail("Bot not found");

      const rows = yield* sql<AccountRow>`SELECT a.* FROM connector_accounts a WHERE owner_user_id=${user}::uuid
      AND (${workerId ?? null}::uuid IS NULL OR (a.all_workers OR EXISTS(SELECT 1 FROM connector_worker_grants g WHERE g.account_id=a.id AND g.worker_id=${workerId ?? null}::uuid)))
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

  return { owned, view, authorize, list, audit };
}

export type ConnectorBase = ReturnType<typeof connectorSealing> & ReturnType<typeof connectorAccounts>;
