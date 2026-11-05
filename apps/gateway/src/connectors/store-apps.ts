import { connectors } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { connectorTransaction } from "../config-sync/connector-records.ts";
import { encryptSecret } from "../store/secrets.ts";
import { connectorType, connectorUrl, oauthRedirectUrl } from "./catalog.ts";
import { checked, fail, type RegisteredApp } from "./records.ts";
import type { ConnectorBase } from "./accounts.ts";

/** Registered clients are shared secrets; the redirect they were registered with travels with them. */
export function connectorApps(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  return {
    app: (user: string, type: string) =>
      sql<{ credentials: Uint8Array }>`SELECT credentials FROM connector_oauth_apps
        WHERE owner_user_id=${user}::uuid AND connector_type=${type}`.pipe(
        Effect.map((r) => (r[0] ? base.opened<RegisteredApp>(r[0].credentials) : undefined)),
      ),
    appTypes: (user: string) =>
      sql<{
        connector_type: string;
      }>`SELECT connector_type FROM connector_oauth_apps WHERE owner_user_id=${user}::uuid`.pipe(
        Effect.map((r) => r.map((v) => v.connector_type)),
      ),
    saveApp: (user: string, request: connectors.SaveConnectorOAuthAppRequest) =>
      connectorTransaction(
        sql,
        key,
        Effect.gen(function* () {
          if (
            !connectorType(request.connectorType) ||
            !request.clientId ||
            request.clientId.length > 2000 ||
            request.clientSecret.length > 32_000
          )
            return yield* fail("A connector type and OAuth client ID are required");
          const issuer = yield* checked(() => connectorUrl(request.issuer));
          const fixed = connectorType(request.connectorType)?.authMethods.some((m) => m.oauthAppRequired);

          const client: RegisteredApp = {
            client_id: request.clientId,
            client_secret: request.clientSecret || undefined,
            issuer,
            ...(fixed && { redirect_uri: oauthRedirectUrl() }),
          };

          yield* sql`INSERT INTO connector_oauth_apps(owner_user_id,connector_type,credentials)
          VALUES (${user}::uuid,${request.connectorType},${encryptSecret(key, JSON.stringify(client))})
          ON CONFLICT(owner_user_id,connector_type) DO UPDATE SET credentials=EXCLUDED.credentials,updated_at=now()`;
        }),
      ),
  };
}
