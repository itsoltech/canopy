import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConnectorBase } from "./accounts.ts";
import { digest, type AccountRow, type Credentials } from "./records.ts";
import { oauthFailure } from "./oauth-error.ts";

interface StateRow {
  account_id: string;
  credentials: Uint8Array;
  account_revision: bigint;
  used: boolean;
  completed: boolean;
}

/** Single-use claims and completion receipts remain owner-, binding- and TTL-scoped. */
export function connectorOAuthState(sql: SqlClient.SqlClient, base: ConnectorBase) {
  return {
    saveState: (user: string, row: AccountRow, state: string, binding: string, value: Credentials) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM connector_oauth_states WHERE owner_user_id=${user}::uuid AND account_id=${row.id}::uuid`;
        yield* sql`INSERT INTO connector_oauth_states(state_hash,owner_user_id,account_id,browser_hash,credentials,account_revision,expires_at)
        VALUES (${digest(state)},${user}::uuid,${row.id}::uuid,${digest(binding)},${base.seal(value)},${BigInt(row.revision)},now()+interval '10 minutes')`;
      }),
    consumeState: (user: string, state: string, binding: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          let row = (yield* sql<StateRow>`UPDATE connector_oauth_states SET consumed_at=now()
        WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NULL AND expires_at>now()
        RETURNING account_id,credentials,account_revision,false AS used,false AS completed`)[0];

          if (!row) {
            const found = (yield* sql<
              StateRow & { matches: boolean; expired: boolean }
            >`SELECT account_id,credentials,account_revision,
              consumed_at IS NOT NULL AS used,completed_at IS NOT NULL AS completed,
              browser_hash=${digest(binding)} AS matches,expires_at<=now() AS expired
              FROM connector_oauth_states WHERE state_hash=${digest(state)} AND owner_user_id=${user}::uuid`)[0];

            if (!found)
              return yield* Effect.fail(
                oauthFailure("oauth_unknown", "This sign-in is no longer available. Start sign-in again."),
              );

            if (!found.matches)
              return yield* Effect.fail(
                oauthFailure(
                  "oauth_binding",
                  "This code belongs to another sign-in window. Use the window that started sign-in, or start again.",
                ),
              );

            if (found.expired)
              return yield* Effect.fail(oauthFailure("oauth_expired", "This code expired. Start sign-in again."));
            row = found;
          }

          return {
            accountId: row.account_id,
            revision: BigInt(row.account_revision),
            used: row.used,
            completed: row.completed,
            value: base.opened<Credentials>(row.credentials),
          };
        }),
      ),
    completeState: (user: string, state: string, binding: string) =>
      sql`UPDATE connector_oauth_states SET completed_at=now() WHERE state_hash=${digest(state)}
        AND owner_user_id=${user}::uuid AND browser_hash=${digest(binding)} AND consumed_at IS NOT NULL`,
  };
}
