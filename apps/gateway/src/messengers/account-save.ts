import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { connectorSealing } from "../connectors/sealing.ts";
import type { RegisteredApp } from "../connectors/records.ts";
import { encryptSecret } from "../store/secrets.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { connectorTransaction } from "../config-sync/connector-records.ts";
import { accountView, openMessengerCredentials, type AccountRow } from "./account-records.ts";
import type { SaveMessengerAccount } from "./types.ts";

export function saveMessengerAccount(
  sql: SqlClient.SqlClient,
  key: Buffer,
  owned: (owner: string, id: string) => Effect.Effect<AccountRow, Invalid | NotFound | SqlError.SqlError>,
) {
  return (owner: string, input: SaveMessengerAccount) =>
    connectorTransaction(
      sql,
      key,
      Effect.gen(function* () {
        if (!input.name.trim() || input.name.length > 120) return yield* Effect.fail(new Invalid("A name is required"));
        yield* sql`SELECT id FROM users WHERE id=${owner}::uuid FOR NO KEY UPDATE`;
        let prior = input.id ? yield* owned(owner, input.id) : undefined;
        const connectorId = input.connectorAccountId || prior?.connector_account_id;

        if (prior?.connector_client_id && !connectorId)
          return yield* Effect.fail(new Invalid("Reconnect the Slack connection first"));
        let app: RegisteredApp | undefined;

        if (connectorId) {
          const saved = (yield* sql<{ credentials: Uint8Array }>`SELECT credentials FROM connector_oauth_apps
        WHERE owner_user_id=${owner}::uuid AND connector_type='slack' FOR UPDATE`)[0];

          app = saved ? connectorSealing(sql, key).opened<RegisteredApp>(saved.credentials) : undefined;

          if (!app?.client_id || !app.client_secret)
            return yield* Effect.fail(new Invalid("Save the shared Slack app first"));

          if (prior?.connector_account_id && prior.connector_account_id !== connectorId)
            return yield* Effect.fail(new Invalid("This messenger belongs to another Slack connection"));
          yield* sql`UPDATE connector_oauth_apps SET client_id=${app.client_id}
        WHERE owner_user_id=${owner}::uuid AND connector_type='slack'`;

          const connector = yield* sql`SELECT id FROM connector_accounts WHERE id=${connectorId}::uuid
        AND owner_user_id=${owner}::uuid AND connector_type='slack' AND auth_kind='oauth' FOR UPDATE`;

          if (!connector.length) return yield* Effect.fail(new Invalid("Choose your Slack connection"));

          const duplicate = yield* sql`SELECT id FROM messenger_accounts WHERE connector_account_id=${connectorId}::uuid
        AND deleted_at IS NULL AND id<>${prior?.id ?? Bun.randomUUIDv7()}::uuid`;

          if (duplicate.length)
            return yield* Effect.fail(new Invalid("This Slack connection already has messaging enabled"));
        }

        // Refresh settlement does not take the shared config lock; reread credentials under the account lock.
        if (prior) {
          yield* sql`SELECT id FROM messenger_accounts WHERE id=${prior.id}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`;
          prior = yield* owned(owner, prior.id);
        }

        const previous = prior ? openMessengerCredentials(key, prior) : undefined;

        const credentials = {
          ...previous,
          appToken: input.appToken || previous?.appToken || "",
          botToken: input.botToken || previous?.botToken || "",
        };

        if (
          !/^xapp-[^\s]+$/.test(credentials.appToken) ||
          credentials.appToken.length > 4096 ||
          (!connectorId &&
            (!/^(xoxb-|xoxe\.xoxb-)[^\s]+$/.test(credentials.botToken) || credentials.botToken.length > 4096))
        )
          return yield* Effect.fail(new Invalid("Slack app token is required; manual accounts also need a bot token"));
        const id = prior?.id ?? Bun.randomUUIDv7();
        const externalId = connectorId ? (prior?.external_id ?? `pending:${id}`) : input.externalId;

        if (!externalId || externalId.length > 200 || (!connectorId && prior && prior.external_id !== externalId))
          return yield* Effect.fail(new Invalid("Reconnect using the same Slack workspace"));

        const duplicate = yield* sql`SELECT id FROM messenger_accounts WHERE owner_user_id=${owner}::uuid
      AND external_id=${externalId} AND deleted_at IS NULL AND id<>${id}::uuid`;

        if (duplicate.length) return yield* Effect.fail(new Invalid("This Slack workspace is already connected"));

        const changed =
          !!input.appToken ||
          !!input.botToken ||
          (connectorId && !prior?.connector_account_id) ||
          (!!app && app.client_id !== prior?.connector_client_id);

        const status =
          connectorId && changed
            ? "needs_authorization"
            : changed
              ? "connecting"
              : (prior?.status ?? "needs_authorization");

        yield* sql`INSERT INTO messenger_accounts(id,owner_user_id,name,external_id,credentials,enabled,status,
      connector_account_id,connector_client_id)
      VALUES(${id}::uuid,${owner}::uuid,${input.name.trim()},${externalId},${encryptSecret(key, JSON.stringify(credentials))},
        ${input.enabled ?? prior?.enabled ?? true},${status},${connectorId ?? null}::uuid,${app?.client_id ?? null})
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,credentials=excluded.credentials,enabled=excluded.enabled,
        status=excluded.status,connector_account_id=excluded.connector_account_id,connector_client_id=excluded.connector_client_id,
        revision=messenger_accounts.revision+CASE WHEN ${!!changed} THEN 1 ELSE 0 END,
        refresh_attempt=CASE WHEN ${!!changed} THEN NULL ELSE messenger_accounts.refresh_attempt END,
        refresh_started_at=CASE WHEN ${!!changed} THEN NULL ELSE messenger_accounts.refresh_started_at END,
        lease_until=CASE WHEN ${!!changed || input.enabled === false} THEN NULL ELSE messenger_accounts.lease_until END,
        lease_token=CASE WHEN ${!!changed || input.enabled === false} THEN NULL ELSE messenger_accounts.lease_token END`;

        return accountView(yield* owned(owner, id));
      }),
    );
}
