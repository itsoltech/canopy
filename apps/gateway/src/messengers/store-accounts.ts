import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { Invalid, NotFound } from "../store/store.ts";
import type { AccountLease, MessengerAccount, MessengerCredentials, SaveMessengerAccount } from "./types.ts";

interface AccountRow {
  id: string;
  owner_user_id: string;
  name: string;
  provider: "slack";
  external_id: string;
  enabled: boolean;
  status: string;
  credentials: Uint8Array;
}

const decodeCredentials = Schema.decodeUnknownSync(Schema.Struct({ appToken: Schema.String, botToken: Schema.String }));

const accountView = (row: AccountRow): MessengerAccount => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  provider: row.provider,
  externalId: row.external_id,
  enabled: row.enabled,
  status: row.status,
});

export function messengerAccounts(sql: SqlClient.SqlClient, key: Buffer) {
  const owned = (owner: string, id: string) =>
    sql<AccountRow>`SELECT * FROM messenger_accounts
    WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("Messenger account not found")),
      ),
    );

  const open = (row: AccountRow): MessengerCredentials =>
    decodeCredentials(JSON.parse(decryptSecret(key, row.credentials)));

  const fenced = (owner: string, lease: AccountLease, now: Date) =>
    sql`SELECT id FROM messenger_accounts
    WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid AND lease_token=${lease.token}::uuid
      AND lease_holder=${lease.holder} AND lease_until>${now} AND enabled AND deleted_at IS NULL FOR UPDATE`.pipe(
      Effect.flatMap((rows) => (rows.length ? Effect.void : Effect.fail(new Invalid("Messenger lease lost")))),
    );

  return {
    owned,
    fenced,
    accounts: (owner: string) =>
      sql<AccountRow>`SELECT id,owner_user_id,name,provider,external_id,enabled,status
      FROM messenger_accounts WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL ORDER BY name,id`.pipe(
        Effect.map((rows) => rows.map(accountView)),
      ),
    credentials: (owner: string, id: string) => owned(owner, id).pipe(Effect.map(open)),
    saveAccount: (owner: string, input: SaveMessengerAccount) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (
            !input.name.trim() ||
            input.name.length > 120 ||
            !input.externalId.trim() ||
            input.externalId.length > 200
          )
            return yield* Effect.fail(new Invalid("A name and verified workspace are required"));
          // Serialize workspace uniqueness and token rotation across all gateway instances.
          yield* sql`SELECT id FROM users WHERE id=${owner}::uuid FOR UPDATE`;
          const prior = input.id ? yield* owned(owner, input.id) : undefined;

          if (prior && prior.external_id !== input.externalId)
            return yield* Effect.fail(new Invalid("Reconnect using the same Slack workspace"));
          const previous = prior ? open(prior) : undefined;

          const credentials = {
            appToken: input.appToken || previous?.appToken || "",
            botToken: input.botToken || previous?.botToken || "",
          };

          if (
            !credentials.appToken.startsWith("xapp-") ||
            !credentials.botToken.startsWith("xoxb-") ||
            credentials.appToken.length > 4096 ||
            credentials.botToken.length > 4096
          )
            return yield* Effect.fail(new Invalid("Slack app and bot tokens are required"));

          const duplicate = yield* sql`SELECT id FROM messenger_accounts WHERE owner_user_id=${owner}::uuid
        AND external_id=${input.externalId} AND deleted_at IS NULL AND id<>${prior?.id ?? Bun.randomUUIDv7()}::uuid`;

          if (duplicate.length) return yield* Effect.fail(new Invalid("This Slack workspace is already connected"));
          const id = prior?.id ?? Bun.randomUUIDv7();
          const rotated = !!input.appToken || !!input.botToken;
          const sealed = encryptSecret(key, JSON.stringify(credentials));
          yield* sql`INSERT INTO messenger_accounts(id,owner_user_id,name,external_id,credentials,enabled)
        VALUES(${id}::uuid,${owner}::uuid,${input.name.trim()},${input.externalId},${sealed},${input.enabled ?? prior?.enabled ?? true})
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,credentials=excluded.credentials,enabled=excluded.enabled,
          status=CASE WHEN ${rotated} THEN 'connecting' ELSE messenger_accounts.status END,
          lease_until=CASE WHEN ${rotated || input.enabled === false} THEN NULL ELSE messenger_accounts.lease_until END,
          lease_token=CASE WHEN ${rotated || input.enabled === false} THEN NULL ELSE messenger_accounts.lease_token END`;

          return accountView(yield* owned(owner, id));
        }),
      ),
    deleteAccount: (owner: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(owner, id);
          yield* sql`UPDATE messenger_accounts SET enabled=false,deleted_at=now(),credentials=${encryptSecret(key, "{}")},
        lease_until=NULL,lease_token=NULL WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;
          yield* sql`UPDATE bot_channel_routes SET deleted_at=now() WHERE account_id=${id}::uuid`;
        }),
      ),
    claimAccount: (owner: string, id: string, holder: string, now: Date) => {
      const token = Bun.randomUUIDv7();

      return sql`UPDATE messenger_accounts SET status='connecting',lease_holder=${holder},lease_token=${token}::uuid,
        lease_until=${new Date(now.getTime() + 30_000)} WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid
        AND enabled AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until<=${now}) RETURNING id`.pipe(
        Effect.map((rows): AccountLease | undefined => (rows.length ? { accountId: id, holder, token } : undefined)),
      );
    },
    renewAccount: (owner: string, lease: AccountLease, now: Date) =>
      sql`UPDATE messenger_accounts
      SET lease_until=${new Date(now.getTime() + 30_000)} WHERE id=${lease.accountId}::uuid AND owner_user_id=${owner}::uuid
      AND lease_token=${lease.token}::uuid AND lease_holder=${lease.holder} AND lease_until>${now}
      AND enabled AND deleted_at IS NULL RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
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
