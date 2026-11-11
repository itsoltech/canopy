import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "../store/secrets.ts";
import { accountView, notFound, TokenPair, type AccountRow } from "./records.ts";
import { githubAttempts } from "./store-attempts.ts";
import { githubCatalogue } from "./store-catalogue.ts";
import { githubCache } from "./store-cache.ts";
import { githubPullRequests } from "./store-pull-requests.ts";
import { githubDetectionStore } from "./store-detection.ts";
import { githubUpdateStore } from "./update-account.ts";
import { githubPollingStore } from "./store-polling.ts";

export function githubStore(sql: SqlClient.SqlClient, key: Buffer) {
  const seal = (value: TokenPair) => encryptSecret(key, JSON.stringify(value));

  // SAFETY: callers open connected device accounts; every transition removing their pair also clears that status.
  const open = (row: AccountRow) =>
    Schema.decodeUnknownSync(TokenPair)(JSON.parse(decryptSecret(key, row.credentials!)));

  const owned = (owner: string, id: string) =>
    Effect.gen(function* () {
      const row =
        (yield* sql<AccountRow>`SELECT * FROM github_accounts WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`)[0];

      if (!row) return yield* Effect.fail(notFound());

      return row;
    });

  const audit = (owner: string, action: string, id: string, client = "") =>
    sql`INSERT INTO audit_log (id,actor_user_id,action,target_type,target_id,details)
      VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${`github.${action}`},'github_account',${id}::uuid,${JSON.stringify({ client })}::jsonb)`;

  const clear = (owner: string, id: string, status: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<AccountRow>`UPDATE github_accounts SET status=${status},credentials=NULL,key_id=NULL,
      refresh_lease=NULL,refresh_lease_until=NULL,catalog_verified_at=NULL,revision=revision+1,updated_at=now()
      WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid RETURNING *`;

        if (!rows[0]) return yield* Effect.fail(notFound());
        yield* sql`DELETE FROM github_installations WHERE owner_user_id=${owner}::uuid AND account_id=${id}::uuid`;
        yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${owner}::uuid AND account_id=${id}::uuid`;
        yield* sql`UPDATE threads SET newest_pull_request=NULL,pull_request_revision=pull_request_revision+1
          WHERE owner_user_id=${owner}::uuid AND id IN (SELECT l.thread_id FROM thread_pull_requests l
          JOIN github_pull_requests p ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id
          JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
          WHERE r.owner_user_id=${owner}::uuid AND r.account_id=${id}::uuid)`;
        yield* audit(owner, status, id);

        return accountView(rows[0]);
      }),
    );

  const saveAccount = (owner: string, userId: string, login: string, tokens: TokenPair) =>
    sql<AccountRow>`INSERT INTO github_accounts(id,owner_user_id,github_user_id,login,auth_kind,status,credentials,key_id)
      VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${userId},${login},'device','connected',${seal(tokens)},${SECRETS_KEY_ID})
      ON CONFLICT (owner_user_id,host,github_user_id) DO UPDATE SET login=excluded.login,status='connected',
      auth_kind='device',connector_account_id=NULL,connector_revision=NULL,
      credentials=excluded.credentials,key_id=excluded.key_id,refresh_lease=NULL,refresh_lease_until=NULL,
      revision=github_accounts.revision+1,catalog_verified_at=NULL,updated_at=now() RETURNING *`;

  return {
    ...githubUpdateStore(sql),
    ...githubPollingStore(sql),
    owned,
    open,
    audit,
    clear,
    list: (owner: string) =>
      sql<AccountRow>`SELECT a.*,
        (SELECT count(*)::integer FROM github_installations i WHERE i.owner_user_id=a.owner_user_id AND i.account_id=a.id) AS installation_count,
        (SELECT count(*)::integer FROM github_installation_repositories r WHERE r.owner_user_id=a.owner_user_id AND r.account_id=a.id) AS repository_count
        FROM github_accounts a WHERE a.owner_user_id=${owner}::uuid ORDER BY a.created_at,a.id`,
    refreshClaim: (row: AccountRow, lease: string, now: number) =>
      sql<AccountRow>`UPDATE github_accounts SET refresh_lease=${lease}::uuid,refresh_lease_until=${new Date(now + 30_000)}
        WHERE owner_user_id=${row.owner_user_id}::uuid AND id=${row.id}::uuid AND revision=${row.revision}::bigint
        AND status='connected' AND refresh_lease IS NULL RETURNING *`,
    refreshFinish: (row: AccountRow, lease: string, tokens: TokenPair, now: number) =>
      sql<AccountRow>`UPDATE github_accounts SET credentials=${seal(tokens)},key_id=${SECRETS_KEY_ID},revision=revision+1,
        refresh_lease=NULL,refresh_lease_until=NULL,updated_at=now()
        WHERE owner_user_id=${row.owner_user_id}::uuid AND id=${row.id}::uuid AND revision=${row.revision}::bigint
        AND status='connected' AND refresh_lease=${lease}::uuid AND refresh_lease_until>${new Date(now)} RETURNING *`,
    clearRevision: (row: AccountRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current =
            yield* sql<AccountRow>`SELECT * FROM github_accounts WHERE owner_user_id=${row.owner_user_id}::uuid
        AND id=${row.id}::uuid AND revision=${row.revision}::bigint FOR UPDATE`;

          if (current[0]) yield* clear(row.owner_user_id, row.id, "needs_reconnect");
        }),
      ),
    ...githubAttempts(sql, key, saveAccount, audit),
    ...githubCatalogue(sql),
    ...githubCache(sql),
    ...githubPullRequests(sql),
    ...githubDetectionStore(sql),
  };
}

export type GitHubStore = ReturnType<typeof githubStore>;
