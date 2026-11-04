import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { connectors, ConnectorToolSchema, type ConnectorTool } from "@canopy/contracts";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { encryptSecret } from "../store/secrets.ts";
import { connectorType, connectorUrl } from "./catalog.ts";
import { checked, digest, fail, type AccountRow, type Credentials, type ExecutionSource } from "./records.ts";
import type { ConnectorBase } from "./accounts.ts";

/** Tools, OAuth apps and state, disconnecting and the execution log. */
export function connectorState(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  const { owned, opened, seal, credentials, view, audit } = base;

  return {
    tools: (row: AccountRow): ConnectorTool[] => row.tools.map((t) => fromJson(ConnectorToolSchema, t)),
    saveTools: (row: AccountRow, tools: ConnectorTool[]) =>
      sql`UPDATE connector_accounts SET tools=${JSON.stringify(tools.map((t) => toJson(ConnectorToolSchema, t)))}::jsonb,status='connected' WHERE id=${row.id}::uuid AND revision=${BigInt(row.revision)}`,
    status: (row: AccountRow, status: string) =>
      sql`UPDATE connector_accounts SET status=${status} WHERE id=${row.id}::uuid AND revision=${BigInt(row.revision)}`,
    app: (user: string, type: string) =>
      sql<{
        credentials: Uint8Array;
      }>`SELECT credentials FROM connector_oauth_apps WHERE owner_user_id=${user}::uuid AND connector_type=${type}`.pipe(
        Effect.map((r) => (r[0] ? opened<OAuthClientInformationMixed>(r[0].credentials) : undefined)),
      ),
    appTypes: (user: string) =>
      sql<{
        connector_type: string;
      }>`SELECT connector_type FROM connector_oauth_apps WHERE owner_user_id=${user}::uuid`.pipe(
        Effect.map((r) => r.map((v) => v.connector_type)),
      ),
    saveApp: (user: string, request: connectors.SaveConnectorOAuthAppRequest) =>
      Effect.gen(function* () {
        if (
          !connectorType(request.connectorType) ||
          !request.clientId ||
          request.clientId.length > 2000 ||
          request.clientSecret.length > 32_000
        )
          return yield* fail("A connector type and OAuth client ID are required");
        const issuer = yield* checked(() => connectorUrl(request.issuer));
        const client = { client_id: request.clientId, client_secret: request.clientSecret || undefined, issuer };
        yield* sql`INSERT INTO connector_oauth_apps(owner_user_id,connector_type,credentials) VALUES (${user}::uuid,${request.connectorType},${encryptSecret(key, JSON.stringify(client))})
        ON CONFLICT(owner_user_id,connector_type) DO UPDATE SET credentials=EXCLUDED.credentials`;
      }),
    saveState: (user: string, row: AccountRow, state: string, binding: string, value: Credentials) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM connector_oauth_states WHERE expires_at < now() OR account_id=${row.id}::uuid`;
        yield* sql`INSERT INTO connector_oauth_states(state_hash,owner_user_id,account_id,browser_hash,credentials,account_revision,expires_at)
        VALUES (${digest(state)},${user}::uuid,${row.id}::uuid,${digest(binding)},${seal(value)},${BigInt(row.revision)},now()+interval '10 minutes')`;
      }),
    consumeState: (user: string, state: string, binding: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = (yield* sql<{
            account_id: string;
            credentials: Uint8Array;
            account_revision: bigint;
          }>`UPDATE connector_oauth_states SET consumed_at=now()
        WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NULL AND expires_at>now() RETURNING account_id,credentials,account_revision`)[0];

          if (!row) {
            const used =
              yield* sql`SELECT 1 FROM connector_oauth_states WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NOT NULL`;

            return yield* fail(
              used.length
                ? "OAuth callback was already used. Start sign-in again."
                : "OAuth session expired or does not match this browser. Reconnect the account.",
            );
          }

          return {
            accountId: row.account_id,
            revision: BigInt(row.account_revision),
            value: opened<Credentials>(row.credentials),
          };
        }),
      ),
    disconnect: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(user, id, true);
          const value = yield* credentials(row);
          yield* sql`UPDATE connector_accounts SET status='disconnected',credentials=NULL,legacy_headers='{}',tools='[]',revision=revision+1,updated_at=now() WHERE id=${id}::uuid`;
          yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${id}::uuid`;

          // Legacy encrypted headers have been copied by reference. Remove only this account's owned secret rows.
          for (const ref of Object.values(row.legacy_headers))
            yield* sql`DELETE FROM secrets WHERE id=${ref.secretRef}::uuid AND owner_user_id=${user}::uuid AND name LIKE 'bot-mcp-%'`;
          yield* audit({ userId: user, accountId: id }, "disconnect", "disconnected");

          return { row, value, account: yield* view(yield* owned(user, id)) };
        }),
      ),
    /** After disconnect: drop the account, its grants and replay records; audit rows stay, unlinked. */
    remove: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE connector_audit SET account_id = NULL WHERE account_id=${id}::uuid`;
          yield* sql`DELETE FROM connector_executions WHERE account_id=${id}::uuid`;
          yield* sql`DELETE FROM connector_accounts WHERE id=${id}::uuid`;
          yield* sql`INSERT INTO connector_audit(owner_user_id,tool,outcome) VALUES (${user}::uuid,'delete','deleted')`;
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
