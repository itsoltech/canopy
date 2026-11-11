import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "../store/secrets.ts";
import { notFound, type AccountRow, type AttemptRow, type TokenPair } from "./records.ts";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

export function githubAttempts(
  sql: SqlClient.SqlClient,
  key: Buffer,
  saveAccount: (
    owner: string,
    userId: string,
    login: string,
    tokens: TokenPair,
  ) => Effect.Effect<readonly AccountRow[], import("effect/sql").SqlError.SqlError>,
  audit: (
    owner: string,
    action: string,
    id: string,
    client?: string,
  ) => Effect.Effect<readonly object[], import("effect/sql").SqlError.SqlError>,
) {
  const attempt = (owner: string, id: string, client: string) =>
    Effect.gen(function* () {
      const row = (yield* sql<AttemptRow>`SELECT * FROM github_device_auth WHERE owner_user_id=${owner}::uuid
      AND id=${id}::uuid AND client_binding=${client}`)[0];

      if (!row) return yield* Effect.fail(notFound());

      return row;
    });

  const finish = (row: AttemptRow, state: string) =>
    sql`UPDATE github_device_auth SET state=${state},device_code=NULL,key_id=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1
      WHERE owner_user_id=${row.owner_user_id}::uuid AND id=${row.id}::uuid AND revision=${row.revision}::bigint AND state='pending'`;

  return {
    attempt,
    finish,
    stopAttempt: (owner: string, id: string, client: string, state: "cancelled" | "expired") =>
      sql`UPDATE github_device_auth SET state=${state},device_code=NULL,key_id=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1
        WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid AND client_binding=${client} AND state='pending'`,
    // SAFETY: only claimed pending attempts reach this method; terminal transitions are fenced by their revision.
    deviceCode: (row: AttemptRow) => decryptSecret(key, row.device_code!),
    previousAttempt: (owner: string, client: string, request: string) =>
      sql<AttemptRow>`SELECT * FROM github_device_auth WHERE owner_user_id=${owner}::uuid AND client_binding=${client}
        AND client_request_id=${request}`,
    saveAttempt: (owner: string, client: string, request: string, clientId: string, value: DeviceCode, now: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM users WHERE id=${owner}::uuid FOR UPDATE`;

          const old = yield* sql<AttemptRow>`SELECT * FROM github_device_auth WHERE owner_user_id=${owner}::uuid
          AND client_binding=${client} AND client_request_id=${request}`;

          if (old[0]) return old[0];

          const pending = yield* sql`SELECT id FROM github_device_auth WHERE owner_user_id=${owner}::uuid
          AND state='pending' AND expires_at>${new Date(now)} LIMIT 10`;

          if (pending.length >= 10) return yield* Effect.fail(new Error("Too many GitHub sign-ins"));

          const rows = yield* sql<AttemptRow>`INSERT INTO github_device_auth
          (id,owner_user_id,client_binding,client_request_id,client_id,device_code,key_id,user_code,verification_uri,
           expires_at,interval_seconds,next_poll_at)
          VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${client},${request},${clientId},${encryptSecret(key, value.deviceCode)},
           ${SECRETS_KEY_ID},${value.userCode},${value.verificationUri},${new Date(value.expiresAt)},${value.interval},${new Date(now + value.interval * 1000)}) RETURNING *`;

          // SAFETY: INSERT without a conflict clause returns exactly the newly inserted attempt or fails.
          return rows[0]!;
        }),
      ),
    expireAttempts: (owner: string, now: number) =>
      sql`UPDATE github_device_auth SET state=CASE WHEN expires_at<=${new Date(now)} THEN 'expired' ELSE 'failed' END,
        device_code=NULL,key_id=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1
        WHERE owner_user_id=${owner}::uuid AND state='pending' AND
        (expires_at<=${new Date(now)} OR lease_until<=${new Date(now)})`,
    claimAttempt: (owner: string, now: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = (yield* sql<AttemptRow>`SELECT * FROM github_device_auth WHERE owner_user_id=${owner}::uuid
        AND state='pending' AND expires_at>${new Date(now)} AND next_poll_at<=${new Date(now)} AND lease_id IS NULL
        ORDER BY next_poll_at LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];

          if (!row) return undefined;

          return (yield* sql<AttemptRow>`UPDATE github_device_auth SET lease_id=${Bun.randomUUIDv7()}::uuid,
        lease_until=${new Date(now + 30_000)},revision=revision+1 WHERE id=${row.id}::uuid RETURNING *`)[0];
        }),
      ),
    pendingAttempt: (row: AttemptRow, slow: boolean, now: number) => {
      const interval = Math.min(3600, row.interval_seconds + (slow ? 5 : 0));

      return sql`UPDATE github_device_auth SET interval_seconds=${interval},next_poll_at=${new Date(now + interval * 1000)},
        lease_id=NULL,lease_until=NULL WHERE owner_user_id=${row.owner_user_id}::uuid AND id=${row.id}::uuid
        AND revision=${row.revision}::bigint AND state='pending'`;
    },
    connectAttempt: (row: AttemptRow, userId: string, login: string, tokens: TokenPair, now: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const valid = yield* sql`SELECT id FROM github_device_auth WHERE owner_user_id=${row.owner_user_id}::uuid
          AND id=${row.id}::uuid AND revision=${row.revision}::bigint AND state='pending'
          AND lease_id=${row.lease_id}::uuid AND expires_at>${new Date(now)} AND lease_until>${new Date(now)} FOR UPDATE`;

          if (!valid.length) return undefined;
          // SAFETY: the account INSERT/ON CONFLICT UPDATE always returns its single account or fails.
          const account = (yield* saveAccount(row.owner_user_id, userId, login, tokens))[0]!;
          yield* sql`DELETE FROM github_installations WHERE owner_user_id=${row.owner_user_id}::uuid AND account_id=${account.id}::uuid`;
          yield* sql`UPDATE github_device_auth SET state='connected',account_id=${account.id}::uuid,
          device_code=NULL,key_id=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1 WHERE id=${row.id}::uuid`;
          yield* audit(row.owner_user_id, "connect", account.id, row.client_binding);

          return account;
        }),
      ),
  };
}
