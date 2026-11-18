import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConnectorBase } from "./accounts.ts";
import { fail, type AccountRow, type Credentials, type RegisteredApp } from "./records.ts";
import { exchangeSlackBot } from "./slack-messaging-oauth.ts";
import { encryptSecret } from "../store/secrets.ts";
import { openMessengerCredentials, type AccountRow as MessengerRow } from "../messengers/account-records.ts";
import { linkedMessengerActive } from "../messengers/linked-account.ts";
import { validateSlackAccount, type SlackTransport } from "../messengers/slack.ts";

export class SlackMessagingSetupConflict extends Error {}

export function connectorSlackMessaging(sql: SqlClient.SqlClient, base: ConnectorBase, key: Buffer) {
  const slackMessagingSender = (row: AccountRow) =>
    sql<{ id: string; revision: bigint | string }>`SELECT a.id,a.revision FROM messenger_accounts a
      WHERE a.connector_account_id=${row.id}::uuid AND a.owner_user_id=${row.owner_user_id}::uuid
        AND a.enabled AND a.deleted_at IS NULL AND ${linkedMessengerActive(sql)}`.pipe(Effect.map((rows) => rows[0]));

  const setup = (row: AccountRow) =>
    Effect.gen(function* () {
      if (row.connector_type !== "slack" || row.auth_kind !== "oauth") return yield* fail("Choose a Slack connection");

      const account =
        (yield* sql<MessengerRow>`SELECT * FROM messenger_accounts WHERE connector_account_id=${row.id}::uuid
      AND owner_user_id=${row.owner_user_id}::uuid AND deleted_at IS NULL FOR UPDATE`)[0];

      if (!account?.connector_client_id) return yield* fail("Set up Slack messaging first");

      return { accountId: account.id, revision: String(account.revision), clientId: account.connector_client_id };
    });

  return {
    slackMessagingSetup: setup,
    slackMessagingSender,
    slackMessagingConnected: (row: AccountRow) => slackMessagingSender(row).pipe(Effect.map(Boolean)),
    completeSlackMessaging: (row: AccountRow, value: Credentials, code: string, transport?: SlackTransport) =>
      Effect.gen(function* () {
        const pending = value.slackMessaging;

        if (!pending || row.connector_type !== "slack" || !value.verifier || !value.redirectUri)
          return yield* fail("Slack authorization session missing");

        const account = (yield* sql<MessengerRow>`SELECT * FROM messenger_accounts WHERE id=${pending.accountId}::uuid
        AND connector_account_id=${row.id}::uuid AND owner_user_id=${row.owner_user_id}::uuid AND deleted_at IS NULL FOR UPDATE`)[0];

        if (!account || String(account.revision) !== pending.revision)
          return yield* fail("Slack messaging changed during sign-in");

        const saved = (yield* sql<{ credentials: Uint8Array }>`SELECT credentials FROM connector_oauth_apps
        WHERE owner_user_id=${row.owner_user_id}::uuid AND connector_type='slack'`)[0];

        const app = saved ? base.opened<RegisteredApp>(saved.credentials) : undefined;

        if (!app || app.client_id !== pending.clientId || app.client_id !== value.client?.client_id)
          return yield* fail("The shared Slack app changed during sign-in");

        const pendingRoutes = yield* sql`SELECT id FROM bot_channel_routes WHERE account_id=${account.id}::uuid
          AND owner_user_id=${row.owner_user_id}::uuid AND deleted_at IS NULL`;

        const installed = yield* sql`SELECT id FROM messenger_accounts WHERE owner_user_id=${row.owner_user_id}::uuid
          AND connector_client_id IS NULL AND deleted_at IS NULL AND id<>${account.id}::uuid
          AND external_id LIKE ${`${value.slackTeamId ?? ""}:%`}`;

        if (pendingRoutes.length && installed.length && account.external_id.startsWith("pending:"))
          return yield* Effect.fail(
            new SlackMessagingSetupConflict(
              "This setup has subscriptions. Link the installed Slack messenger account instead.",
            ),
          );
        const previous = openMessengerCredentials(key, account);
        const grant = { code, redirectUri: value.redirectUri, verifier: value.verifier };

        const tokens = yield* Effect.tryPromise({
          try: () => exchangeSlackBot(app, grant, transport),
          catch: () => new Error("Slack authorization failed"),
        });

        const credentials = { appToken: previous.appToken, ...tokens };

        const identity = yield* Effect.tryPromise({
          try: () => validateSlackAccount(credentials, undefined, transport),
          catch: () => new Error("Slack workspace and app tokens did not match"),
        });

        if (
          !tokens.appId ||
          !tokens.teamId ||
          identity.appId !== tokens.appId ||
          identity.teamId !== tokens.teamId ||
          (value.slackTeamId && value.slackTeamId !== tokens.teamId) ||
          (!account.external_id.startsWith("pending:") && account.external_id !== identity.externalId)
        )
          return yield* fail("Slack workspace or app did not match this connection");

        const legacy =
          (yield* sql<MessengerRow>`SELECT * FROM messenger_accounts WHERE owner_user_id=${row.owner_user_id}::uuid
        AND external_id=${identity.externalId} AND deleted_at IS NULL AND id<>${account.id}::uuid FOR UPDATE`)[0];

        if (legacy?.connector_client_id) return yield* fail("This workspace bot already belongs to a Slack connection");

        if (legacy && pendingRoutes.length)
          return yield* Effect.fail(
            new SlackMessagingSetupConflict(
              "This setup has subscriptions. Link the installed Slack messenger account instead.",
            ),
          );

        if (legacy) {
          yield* sql`UPDATE messenger_accounts SET deleted_at=now(),enabled=false,connector_account_id=NULL,
          status='disconnected',lease_token=NULL,lease_until=NULL,credentials=${encryptSecret(key, "{}")} WHERE id=${account.id}::uuid`;
        }

        const target = legacy ?? account;
        yield* sql`UPDATE connector_accounts SET slack_team_id=${identity.teamId} WHERE id=${row.id}::uuid
          AND owner_user_id=${row.owner_user_id}::uuid`;
        yield* sql`UPDATE messenger_accounts SET connector_account_id=${row.id}::uuid,connector_client_id=${app.client_id},connector_team_id=${identity.teamId},
        external_id=${identity.externalId},credentials=${encryptSecret(key, JSON.stringify(credentials))},status='connecting',
        revision=revision+1,lease_token=NULL,lease_until=NULL,refresh_attempt=NULL,refresh_started_at=NULL
        WHERE id=${target.id}::uuid AND owner_user_id=${row.owner_user_id}::uuid`;
      }),
  };
}
