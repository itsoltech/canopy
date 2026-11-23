import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreRuntime } from "../core/core.ts";
import { GatewayStore } from "../store/store.ts";
import { oauthEgress } from "./oauth-egress.ts";
import { OAuthNetworkFailure } from "./oauth-network.ts";
import { authorizeOAuth } from "./oauth.ts";
import { ConnectorFailure, oauthIdentityChanged, type AccountRow, type Credentials } from "./records.ts";
import type { ConnectorStore } from "./store.ts";

const failure = () => new ConnectorFailure("Connector needs reconnect");
const usable = (row: AccountRow, testing: boolean) => row.status === "connected" || (testing && row.status === "error");

/** Only Slack user OAuth uses this path. A committed claim fences every single-use refresh exchange. */
export async function slackUserCredentials(runtime: CoreRuntime, owner: string, id: string, testing: boolean) {
  try {
    return await refreshCredentials(runtime, owner, id, testing);
  } catch (error) {
    if (error instanceof OAuthNetworkFailure) throw error;
    // SQL failures can contain sealed values/parameters. Expose only the reconnect action.
    throw failure();
  }
}

async function refreshCredentials(runtime: CoreRuntime, owner: string, id: string, testing: boolean) {
  const run = <A, E>(use: (store: ConnectorStore, sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const gateway = yield* GatewayStore;
        const sql = yield* SqlClient.SqlClient;

        return yield* use(gateway.connectors, sql);
      }),
    );

  const deadline = Date.now() + 32_000;

  for (;;) {
    const claim = await run((store, sql) =>
      store.transaction(
        Effect.gen(function* () {
          const row = yield* store.owned(owner, id, true);

          if (row.connector_type !== "slack" || row.auth_kind !== "oauth" || !usable(row, testing))
            return yield* Effect.fail(failure());
          const value = yield* store.credentials(row);
          const app = yield* store.app(owner, "slack");

          if (!app || !value.client || app.client_id !== value.client.client_id) {
            yield* store.status(row, "needs_reconnect");

            return { kind: "failed" as const };
          }

          value.client = { ...value.client, client_secret: app.client_secret };

          if (row.slack_refresh_attempt) {
            if (row.slack_refresh_started_at && Date.now() - new Date(row.slack_refresh_started_at).getTime() < 30_000)
              return { kind: "wait" as const };
            yield* store.status(row, "needs_reconnect");

            return { kind: "failed" as const };
          }

          if (value.tokens && (value.expiresAt === undefined || value.expiresAt > Date.now() + 30_000))
            return { kind: "ready" as const, row, value };

          if (!value.tokens?.refresh_token) {
            yield* store.status(row, "needs_reconnect");

            return { kind: "failed" as const };
          }

          const attempt = Bun.randomUUIDv7();

          const claimed = yield* sql`UPDATE connector_accounts
            SET slack_refresh_attempt=${attempt}::uuid,slack_refresh_started_at=now()
            WHERE id=${row.id}::uuid AND owner_user_id=${owner}::uuid RETURNING id`;

          if (!claimed.length) return yield* Effect.fail(failure());

          return {
            kind: "refresh" as const,
            value,
            attempt,
            id: row.id,
            row,
            issuer: app.issuer,
            refreshToken: value.tokens.refresh_token,
          };
        }),
      ),
    );

    if (claim.kind === "ready") return { row: claim.row, value: claim.value };

    if (claim.kind === "failed" || Date.now() >= deadline) throw failure();

    if (claim.kind === "wait") {
      await delay(25);
      continue;
    }

    // No database transaction is open during HTTP. A crash leaves the committed claim unresolved.
    const egress = oauthEgress(claim.row.url, claim.issuer, { publicOrigins: claim.value.oauthPublicOrigins });

    let refreshed: boolean | OAuthNetworkFailure;

    try {
      const redirect = await authorizeOAuth(claim.row, egress, claim.value, "");

      refreshed = !redirect && !!claim.value.tokens?.refresh_token;
    } catch (error) {
      refreshed = error instanceof OAuthNetworkFailure ? error : false;
    }

    const settled = await run((store) =>
      store.transaction(
        Effect.gen(function* () {
          const row = yield* store.owned(owner, claim.id, true);
          const current = yield* store.credentials(row);

          if (
            row.slack_refresh_attempt !== claim.attempt ||
            current.tokens?.refresh_token !== claim.refreshToken ||
            !usable(row, testing)
          )
            return undefined;

          if (refreshed !== true || !sameIdentity(current, claim.value)) {
            yield* store.status(row, "needs_reconnect");

            return refreshed instanceof OAuthNetworkFailure ? refreshed : undefined;
          }

          // Metadata and grants may have changed while HTTP ran. Keep their current revision/status.
          yield* store.updateCredentials(row, claim.value);

          return { row, value: claim.value };
        }),
      ),
    );

    if (settled instanceof OAuthNetworkFailure) throw settled;

    if (!settled) throw failure();

    return settled;
  }
}

function sameIdentity(previous: Credentials, next: Credentials) {
  return (!previous.slackTeamId || previous.slackTeamId === next.slackTeamId) && !oauthIdentityChanged(previous, next);
}
