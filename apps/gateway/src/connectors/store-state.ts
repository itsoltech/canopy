import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { connectors, ConnectorToolSchema, type ConnectorTool } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { type AccountRow, type ExecutionSource } from "./records.ts";
import type { ConnectorBase } from "./accounts.ts";
import { connectorTransaction } from "../config-sync/connector-records.ts";
import { removeConnector } from "../config-sync/connector-apply.ts";
import { connectorOAuthState } from "./store-oauth-state.ts";

/** Tools, OAuth apps and state, disconnecting and the execution log. */
export function connectorState(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  const { owned, credentials, view, audit } = base;

  return {
    ...connectorOAuthState(sql, base),
    tools: (row: AccountRow): ConnectorTool[] => row.tools.map((t) => fromJson(ConnectorToolSchema, t)),
    saveTools: (row: AccountRow, tools: ConnectorTool[]) =>
      connectorTransaction(
        sql,
        key,
        sql`UPDATE connector_accounts SET tools=${JSON.stringify(tools.map((t) => toJson(ConnectorToolSchema, t)))}::jsonb,status='connected',error=NULL,updated_at=now() WHERE id=${row.id}::uuid AND owner_user_id=${row.owner_user_id}::uuid AND revision=${BigInt(row.revision)}`,
      ),
    status: (row: AccountRow, status: string, error?: connectors.ConnectorError) =>
      sql`UPDATE connector_accounts SET status=${status},error=${error ? JSON.stringify(toJson(connectors.ConnectorErrorSchema, error)) : null}::jsonb WHERE id=${row.id}::uuid AND revision=${BigInt(row.revision)}`,
    disconnect: (user: string, id: string) =>
      connectorTransaction(
        sql,
        key,
        Effect.gen(function* () {
          const row = yield* owned(user, id, true);
          const value = yield* credentials(row);
          yield* sql`UPDATE connector_accounts SET status='disconnected',error=NULL,credentials=NULL,legacy_headers='{}',tools='[]',revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid`;
          yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${row.id}::uuid`;

          // Legacy encrypted headers have been copied by reference. Remove only this account's owned secret rows.
          for (const ref of Object.values(row.legacy_headers))
            yield* sql`DELETE FROM secrets WHERE id=${ref.secretRef}::uuid AND owner_user_id=${user}::uuid AND name LIKE 'bot-mcp-%'`;
          yield* audit({ userId: user, accountId: row.id }, "disconnect", "disconnected");

          return { row, value, account: yield* view(yield* owned(user, id)) };
        }),
      ),
    /**
     * Drop the account without revoking its recoverable credentials; audit stays, unlinked. With `expectedRevision`
     * an account changed since stays ("changed"); the check holds the account's lock until the delete commits.
     * `receipt` runs last in the same transaction (imports, docs/import.md "Blokady").
     */
    remove: (
      user: string,
      id: string,
      options: {
        readonly expectedRevision?: bigint;
        readonly receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>;
        readonly changedReceipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>;
      } = {},
    ) =>
      connectorTransaction(
        sql,
        key,
        Effect.gen(function* () {
          const row = yield* owned(user, id, true);

          if (options.expectedRevision !== undefined && BigInt(row.revision) !== options.expectedRevision) {
            if (options.changedReceipt) yield* options.changedReceipt(sql);

            return "changed" as const;
          }

          yield* removeConnector(sql, user, row.id);
          yield* sql`INSERT INTO connector_audit(owner_user_id,tool,outcome) VALUES (${user}::uuid,'delete','deleted')`;

          if (options.receipt) yield* options.receipt(sql);

          return "removed" as const;
        }),
      ),
    execution: (id: string) =>
      sql<{
        fingerprint: string;
        status: string;
        result: JsonValue | null;
      }>`SELECT fingerprint,status,result FROM connector_executions WHERE id=${id}::uuid`.pipe(Effect.map((r) => r[0])),
    claimExecution: (id: string, source: ExecutionSource, tool: string, fingerprint: string) =>
      sql`INSERT INTO connector_executions(id,account_id,owner_user_id,thread_id,bot_id,tool,fingerprint,status)
      VALUES (${id}::uuid,${source.accountId}::uuid,${source.userId}::uuid,${source.threadId ?? null}::uuid,${source.botId ?? null}::uuid,${tool},${fingerprint},'running') ON CONFLICT(id) DO NOTHING RETURNING id`.pipe(
        Effect.map((r) => r.length > 0),
      ),
    finishExecution: (id: string, source: ExecutionSource, tool: string, result: JsonValue, isError: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE connector_executions SET status=${isError ? "error" : "completed"},result=${JSON.stringify(result)}::jsonb,finished_at=now() WHERE id=${id}::uuid`;
          yield* sql`UPDATE connector_accounts SET last_used_at=now() WHERE id=${source.accountId}::uuid`;
          yield* audit(source, tool, isError ? "error" : "completed");
        }),
      ),
  };
}
