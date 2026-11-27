import { lockedOwnerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { encryptSecret } from "../store/secrets.ts";
import { Invalid, NotFound } from "../store/store.ts";
import type { AccountLease } from "./types.ts";
import { accountView, openMessengerCredentials, type AccountRow } from "./account-records.ts";
import { saveMessengerAccount } from "./account-save.ts";
import { messengerCredentials } from "./account-credentials.ts";
import { linkedMessengerActive } from "./linked-account.ts";

export function messengerAccounts(sql: SqlClient.SqlClient, key: Buffer) {
  const owned = (owner: string, id: string) =>
    sql<AccountRow>`SELECT * FROM messenger_accounts
      WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("Messenger account not found")),
      ),
    );

  const active = (owner: string, id: string) =>
    sql`SELECT a.id FROM messenger_accounts a
    WHERE a.id=${id}::uuid AND a.owner_user_id=${owner}::uuid AND a.enabled AND a.deleted_at IS NULL
    AND ${linkedMessengerActive(sql)}`.pipe(Effect.map((rows) => rows.length > 0));

  const fenced = (owner: string, lease: AccountLease, now: Date) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT id FROM messenger_accounts
      WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid AND lease_token=${lease.token}::uuid
      AND lease_holder=${lease.holder} AND lease_until>${now} AND enabled AND deleted_at IS NULL FOR UPDATE`;

      if (!rows.length || !(yield* active(owner, lease.accountId)))
        return yield* Effect.fail(new Invalid("Messenger lease lost"));
    });

  return {
    owned,
    fenced,
    active,
    accounts: (owner: string) =>
      sql<AccountRow>`SELECT * FROM messenger_accounts
      WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL ORDER BY name,id`.pipe(
        Effect.map((rows) => rows.map(accountView)),
      ),
    credentials: messengerCredentials(sql, key),
    savedCredentials: (owner: string, id: string) =>
      owned(owner, id).pipe(Effect.map((row) => openMessengerCredentials(key, row))),
    standaloneCredentialsForSave: (owner: string, id: string) =>
      owned(owner, id).pipe(
        Effect.map((row) => {
          if (row.connector_account_id || row.connector_client_id) return undefined;
          const { appToken, botToken } = openMessengerCredentials(key, row);

          return { provider: row.provider, appToken, botToken, revision: BigInt(row.revision) };
        }),
      ),
    saveAccount: saveMessengerAccount(sql, key, owned),
    deleteAccount: (owner: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(owner, id);
          yield* sql`UPDATE messenger_accounts SET enabled=false,deleted_at=now(),credentials=${encryptSecret(key, "{}")},
        lease_until=NULL,lease_token=NULL,revision=revision+1 WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;
          yield* sql`UPDATE bot_channel_routes SET deleted_at=now() WHERE account_id=${id}::uuid`;
        }),
      ),
    claimAccount: (owner: string, id: string, holder: string, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return undefined;
          yield* sql`SELECT id FROM messenger_accounts WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`;

          if (!(yield* active(owner, id))) return undefined;
          const token = Bun.randomUUIDv7();

          const rows =
            yield* sql`UPDATE messenger_accounts SET status='connecting',lease_holder=${holder},lease_token=${token}::uuid,
        lease_until=${new Date(now.getTime() + 30_000)} WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid
        AND enabled AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until<=${now}) RETURNING id`;

          return rows.length ? { accountId: id, holder, token } : undefined;
        }),
      ),
    renewAccount: (owner: string, lease: AccountLease, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return false;
          yield* sql`SELECT id FROM messenger_accounts WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`;

          if (!(yield* active(owner, lease.accountId))) return false;

          const rows = yield* sql`UPDATE messenger_accounts SET lease_until=${new Date(now.getTime() + 30_000)}
        WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid AND lease_token=${lease.token}::uuid
        AND lease_holder=${lease.holder} AND lease_until>${now} AND enabled AND deleted_at IS NULL RETURNING id`;

          return rows.length > 0;
        }),
      ),
    releaseAccount: (
      owner: string,
      lease: AccountLease,
    ) => sql`UPDATE messenger_accounts SET lease_until=NULL,lease_token=NULL
      WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid AND lease_token=${lease.token}::uuid`,
    setAccountStatus: (owner: string, lease: AccountLease, status: string) =>
      sql`UPDATE messenger_accounts SET status=${status}
      WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid AND lease_token=${lease.token}::uuid
      AND lease_until>now() AND enabled AND deleted_at IS NULL`.pipe(Effect.asVoid),
  };
}

export type MessengerAccounts = ReturnType<typeof messengerAccounts>;
