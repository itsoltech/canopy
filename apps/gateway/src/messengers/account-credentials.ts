import { Effect } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import type { SqlClient } from "effect/sql";
import { connectorSealing } from "../connectors/sealing.ts";
import type { RegisteredApp } from "../connectors/records.ts";
import { exchangeSlackBot } from "../connectors/slack-messaging-oauth.ts";
import { encryptSecret } from "../store/secrets.ts";
import { Invalid } from "../store/store.ts";
import { linkedMessengerActive } from "./linked-account.ts";
import { openMessengerCredentials, type AccountRow } from "./account-records.ts";
import type { SlackTransport } from "./slack-http.ts";

/** A committed refresh claim prevents replaying single-use refresh tokens after process/connection loss. */
export function messengerCredentials(sql: SqlClient.SqlClient, key: Buffer) {
  const sealing = connectorSealing(sql, key);

  const acquire = (owner: string, id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const row = (yield* sql<AccountRow>`SELECT * FROM messenger_accounts WHERE id=${id}::uuid
      AND owner_user_id=${owner}::uuid AND deleted_at IS NULL FOR UPDATE`)[0];

        if (!row || !row.enabled) return yield* Effect.fail(new Invalid("Messenger account unavailable"));

        const active =
          yield* sql`SELECT a.id FROM messenger_accounts a WHERE a.id=${id}::uuid AND ${linkedMessengerActive(sql)}`;

        if (!active.length) return yield* Effect.fail(new Invalid("Slack messaging needs authorization"));
        const value = openMessengerCredentials(key, row);

        if (!value.expiresAt || value.expiresAt > Date.now() + 60_000) return { kind: "ready" as const, value };

        if (
          row.refresh_attempt &&
          row.refresh_started_at &&
          Date.now() - new Date(row.refresh_started_at).getTime() < 30_000
        )
          return { kind: "wait" as const };

        if (row.refresh_attempt || !value.refreshToken || !value.clientId || !row.connector_account_id) {
          yield* sql`UPDATE messenger_accounts SET status='needs_reconnect',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid`;

          return { kind: "failed" as const };
        }

        const saved = (yield* sql<{ credentials: Uint8Array }>`SELECT credentials FROM connector_oauth_apps
      WHERE owner_user_id=${owner}::uuid AND connector_type='slack'`)[0];

        const app = saved ? sealing.opened<RegisteredApp>(saved.credentials) : undefined;

        if (!app?.client_secret || app.client_id !== value.clientId)
          return yield* Effect.fail(new Invalid("Slack messaging needs authorization"));
        const attempt = Bun.randomUUIDv7();
        yield* sql`UPDATE messenger_accounts SET refresh_attempt=${attempt}::uuid,refresh_started_at=now() WHERE id=${id}::uuid`;

        return {
          kind: "refresh" as const,
          value,
          refreshToken: value.refreshToken,
          app,
          attempt,
          revision: BigInt(row.revision),
        };
      }),
    );

  const current = (owner: string, id: string, transport?: SlackTransport) =>
    Effect.gen(function* () {
      const deadline = Date.now() + 32_000;

      for (;;) {
        const result = yield* acquire(owner, id);

        if (result.kind === "ready") return result.value;

        if (result.kind === "failed" || Date.now() > deadline)
          return yield* Effect.fail(new Invalid("Slack messaging needs reconnect"));

        if (result.kind === "wait") {
          yield* Effect.promise(() => delay(25));
          continue;
        }

        const rotated = yield* Effect.tryPromise({
          try: () => exchangeSlackBot(result.app, { refreshToken: result.refreshToken }, transport),
          catch: () => new Invalid("Slack messaging needs reconnect"),
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));

        const value = yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = (yield* sql<AccountRow>`SELECT * FROM messenger_accounts WHERE id=${id}::uuid
          AND owner_user_id=${owner}::uuid AND deleted_at IS NULL FOR UPDATE`)[0];

            const active =
              yield* sql`SELECT a.id FROM messenger_accounts a WHERE a.id=${id}::uuid AND ${linkedMessengerActive(sql)}`;

            if (
              !row ||
              row.refresh_attempt !== result.attempt ||
              BigInt(row.revision) !== result.revision ||
              !active.length
            )
              return undefined;

            if (
              !rotated ||
              !rotated.refreshToken ||
              !rotated.expiresAt ||
              (rotated.appId && result.value.appId && rotated.appId !== result.value.appId) ||
              (rotated.teamId && result.value.teamId && rotated.teamId !== result.value.teamId)
            ) {
              yield* sql`UPDATE messenger_accounts SET status='needs_reconnect',lease_token=NULL,lease_until=NULL WHERE id=${id}::uuid`;

              return undefined;
            }

            const current = { ...result.value, ...rotated };
            yield* sql`UPDATE messenger_accounts SET credentials=${encryptSecret(key, JSON.stringify(current))},
          refresh_attempt=NULL,refresh_started_at=NULL WHERE id=${id}::uuid`;

            return row.enabled ? current : undefined;
          }),
        );

        if (!value) return yield* Effect.fail(new Invalid("Slack messaging needs reconnect"));

        return value;
      }
    });

  return (owner: string, id: string, transport?: SlackTransport) =>
    current(owner, id, transport).pipe(Effect.map((value) => ({ appToken: value.appToken, botToken: value.botToken })));
}
