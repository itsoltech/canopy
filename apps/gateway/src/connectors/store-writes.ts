import { connectors } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { connectorType, connectorUrl } from "./catalog.ts";
import { checked, digest, fail, type Credentials } from "./records.ts";
import type { ConnectorBase } from "./accounts.ts";

/** Saving accounts and their worker and bot access. */
export function connectorWrites(sql: SqlClient.SqlClient, base: ConnectorBase) {
  const { owned, seal, credentials, view, audit } = base;

  return {
    save: (user: string, request: connectors.SaveConnectorAccountRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const old = request.id ? yield* owned(user, request.id, true) : undefined;

          if (old && BigInt(old.revision) !== request.expectedRevision)
            return yield* fail("Connector changed; reload and try again");
          const type = connectorType(old?.connector_type ?? request.connectorType);
          const name = request.name.trim().normalize("NFC");

          // oxlint-disable-next-line no-control-regex -- an account name is one line of visible text
          if (!type || !name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
            return yield* fail("Choose a connector type and an account name (up to 80 characters)");
          const url = yield* checked(() => connectorUrl(request.url || old?.url || type.url));
          const transport = request.transport || old?.transport || "http";
          const authKind = request.authKind || old?.auth_kind || type.authKinds[0]!;

          if (!["http", "sse"].includes(transport) || !type.authKinds.includes(authKind))
            return yield* fail("Unsupported connector transport or authentication");

          if (
            old &&
            (url !== old.url || transport !== old.transport || authKind !== old.auth_kind) &&
            !request.replaceCredentials
          )
            return yield* fail("Reconnect to change the endpoint or authentication");
          const id = old?.id ?? Bun.randomUUIDv7();

          const namespace =
            old?.namespace ??
            `${type.id}_${
              name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .slice(0, 12) || "account"
            }_${digest(id).slice(0, 8)}`;

          let value: Credentials = old ? yield* credentials(old) : {};

          const replacing =
            request.replaceCredentials || !old || !!request.token || Object.keys(request.headers).length > 0;

          if (replacing) {
            const headers = { ...request.headers };

            if (request.token) headers["Authorization"] = `Bearer ${request.token}`;

            if (Object.keys(headers).length > 32) return yield* fail("Too many connector headers");

            for (const [header, text] of Object.entries(headers))
              if (
                !/^[a-zA-Z0-9_-]{1,100}$/.test(header) ||
                /^(host|content-length|connection|accept|content-type|mcp-session-id)$/i.test(header) ||
                /[\r\n]/.test(text) ||
                text.length > 32_000
              )
                return yield* fail("Invalid connector header");

            if (new Set(Object.keys(headers).map((h) => h.toLowerCase())).size !== Object.keys(headers).length)
              return yield* fail("Duplicate connector header");
            // Reconnect clears tokens, but a DCR client for the same endpoint can be reused after discovery.
            value = {
              headers,
              ...(old?.url === url &&
                old.transport === transport &&
                old.auth_kind === "oauth" &&
                authKind === "oauth" &&
                value.client && { client: value.client, redirectUri: value.redirectUri }),
            };
          }

          const status = replacing ? (authKind === "oauth" ? "needs_reconnect" : "connected") : old!.status;
          yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,credentials,status)
        VALUES (${id}::uuid,${user}::uuid,${type.id},${name},${namespace},${url},${transport},${authKind},${seal(value)},${status})
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,transport=EXCLUDED.transport,auth_kind=EXCLUDED.auth_kind,
        credentials=EXCLUDED.credentials,legacy_headers='{}',status=EXCLUDED.status,tools=CASE WHEN ${replacing || old?.name !== name} THEN '[]'::jsonb ELSE connector_accounts.tools END,
        revision=connector_accounts.revision+1,updated_at=now()`;

          if (replacing) yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${id}::uuid`;

          return yield* view(yield* owned(user, id));
        }),
      ),
    access: (user: string, request: connectors.SetConnectorAccessRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(user, request.accountId, true);

          if (BigInt(row.revision) !== request.expectedRevision)
            return yield* fail("Connector changed; reload and try again");

          if (request.workerIds.length > 256 || request.botIds.length > 256)
            return yield* fail("Too many connector grants");

          for (const id of new Set(request.workerIds))
            if (
              !(yield* sql`SELECT id FROM workers WHERE id=${id}::uuid AND (owner_user_id=${user}::uuid OR owner_user_id IS NULL) AND revoked_at IS NULL AND archived_at IS NULL`)
                .length
            )
              return yield* fail("Worker not found");

          for (const id of new Set(request.botIds))
            if (
              !(yield* sql`SELECT id FROM bots WHERE id=${id}::uuid AND owner_user_id=${user}::uuid AND deleted_at IS NULL`)
                .length
            )
              return yield* fail("Bot not found");
          yield* sql`UPDATE connector_accounts SET all_workers=${request.allWorkers},all_bots=${request.allBots},revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid`;
          yield* sql`DELETE FROM connector_worker_grants WHERE account_id=${row.id}::uuid`;
          yield* sql`DELETE FROM connector_bot_grants WHERE account_id=${row.id}::uuid`;

          for (const id of new Set(request.workerIds))
            yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id) VALUES (${row.id}::uuid,${id}::uuid)`;

          for (const id of new Set(request.botIds))
            yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id) VALUES (${row.id}::uuid,${id}::uuid)`;
          yield* sql`UPDATE bots SET revision=revision+1 WHERE owner_user_id=${user}::uuid`;
          yield* audit({ userId: user, accountId: row.id }, "access", "updated");

          return yield* view(yield* owned(user, row.id));
        }),
      ),
  };
}
