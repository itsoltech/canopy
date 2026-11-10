import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";
import { pruneGitHubCache } from "./prune-cache.ts";
import { Code, ConnectError } from "@connectrpc/connect";

export interface CacheRow {
  generation: bigint;
  payload: Schema.JsonObject | null;
  etag: string;
  verified_at: Date | null;
  expires_at: Date;
  lease_until: Date | null;
}

export interface StoredCacheRow extends Omit<CacheRow, "payload"> {
  serialized_payload: string | null;
}

export interface BudgetRow {
  used: number;
  remaining: number;
  limit_count: number;
  reset_at: Date;
  retry_at: Date;
  failures: number;
}

export interface BudgetUpdate {
  remaining?: number | undefined;
  limit?: number | undefined;
  reset?: number | undefined;
  retry?: number | undefined;
  failed: boolean;
  cost: number;
}

export function githubCache(sql: SqlClient.SqlClient) {
  return {
    cachePrune: (owner: string, reserve = 0) => pruneGitHubCache(sql, owner, reserve),
    cacheRead: (row: AccountRow, key: string) =>
      sql<StoredCacheRow>`UPDATE github_pr_cache c SET last_read_at=now() WHERE owner_user_id=${row.owner_user_id}::uuid
        AND account_id=${row.id}::uuid AND access_revision=${row.revision}::bigint AND cache_key=${key}
        AND EXISTS(SELECT 1 FROM github_accounts a WHERE a.owner_user_id=c.owner_user_id AND a.id=c.account_id
          AND a.status='connected' AND a.revision=c.access_revision)
        RETURNING c.generation,c.payload::text AS serialized_payload,c.etag,c.verified_at,c.expires_at,c.lease_until`,
    cacheClaim: (row: AccountRow, key: string, lease: string) =>
      sql`INSERT INTO github_pr_cache(owner_user_id,account_id,access_revision,cache_key,lease_id,lease_until)
        VALUES (${row.owner_user_id}::uuid,${row.id}::uuid,${row.revision}::bigint,${key},${lease}::uuid,now()+interval '60 seconds')
        ON CONFLICT (owner_user_id,account_id,access_revision,cache_key) DO UPDATE
        SET lease_id=excluded.lease_id,lease_until=excluded.lease_until
        WHERE github_pr_cache.lease_until IS NULL OR github_pr_cache.lease_until<now() RETURNING lease_id`,
    cacheFinish: (
      row: AccountRow,
      key: string,
      lease: string,
      payload: Schema.JsonObject,
      etag: string,
      now: number,
      ttl: number,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`github-cache:${row.owner_user_id}`}))`;

          const size = (yield* sql<{
            bytes: string;
            logs: string;
          }>`SELECT coalesce(sum(octet_length(payload::text)),0)::text AS bytes,
        coalesce(sum(CASE WHEN cache_key LIKE 'logs:%' THEN octet_length(payload::text) ELSE 0 END),0)::text AS logs
        FROM github_pr_cache WHERE owner_user_id=${row.owner_user_id}::uuid
        AND (account_id,access_revision,cache_key)<>(${row.id}::uuid,${row.revision}::bigint,${key})`)[0]!;

          const bytes = Number(
            (yield* sql<{
              bytes: string;
            }>`SELECT octet_length(${JSON.stringify(payload)}::jsonb::text)::text AS bytes`)[0]!.bytes,
          );

          if (
            Number(size.bytes) + bytes > 104857600 ||
            (key.startsWith("logs:") && Number(size.logs) + bytes > 16777216)
          )
            return yield* Effect.fail(
              new ConnectError("GitHub cache is full. Retry after older summaries expire.", Code.ResourceExhausted),
            );

          return yield* sql`UPDATE github_pr_cache c SET payload=${JSON.stringify(payload)}::jsonb,etag=${etag},verified_at=${new Date(now)},
        expires_at=${new Date(now + ttl)},generation=generation+1,lease_id=NULL,lease_until=NULL
        WHERE c.owner_user_id=${row.owner_user_id}::uuid AND c.account_id=${row.id}::uuid
        AND c.access_revision=${row.revision}::bigint AND c.cache_key=${key} AND c.lease_id=${lease}::uuid
        AND EXISTS(SELECT 1 FROM github_accounts a WHERE a.owner_user_id=c.owner_user_id AND a.id=c.account_id
          AND a.status='connected' AND a.revision=c.access_revision) RETURNING cache_key`;
        }),
      ),
    cacheRelease: (row: AccountRow, key: string, lease: string) =>
      sql`UPDATE github_pr_cache SET lease_id=NULL,lease_until=NULL WHERE owner_user_id=${row.owner_user_id}::uuid
        AND account_id=${row.id}::uuid AND access_revision=${row.revision}::bigint AND cache_key=${key} AND lease_id=${lease}::uuid`,
    cacheInvalidate: (owner: string, account: string) =>
      sql`DELETE FROM github_pr_cache WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid`,
    budget: (user: string, resource: string, now: number) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO github_api_budgets(github_user_id,resource,window_at,reset_at,retry_at)
          VALUES (${user},${resource},${new Date(now)},${new Date(now + 3_600_000)},${new Date(now)}) ON CONFLICT DO NOTHING`;

        return (yield* sql<BudgetRow>`UPDATE github_api_budgets SET
          used=CASE WHEN window_at<${new Date(now - 3_600_000)} THEN 0 ELSE used END,
          window_at=CASE WHEN window_at<${new Date(now - 3_600_000)} THEN ${new Date(now)} ELSE window_at END,
          remaining=CASE WHEN reset_at<${new Date(now)} THEN limit_count ELSE remaining END
          WHERE github_user_id=${user} AND resource=${resource} RETURNING *`)[0]!;
      }),
    budgetRecord: (user: string, resource: string, value: BudgetUpdate, now: number) =>
      sql`UPDATE github_api_budgets SET used=used+${value.cost},remaining=coalesce(${value.remaining ?? null},greatest(0,remaining-${value.cost})),
        limit_count=coalesce(${value.limit ?? null},limit_count),reset_at=coalesce(${value.reset ? new Date(value.reset) : null},reset_at),
        retry_at=${new Date(value.retry ?? now)},failures=CASE WHEN ${value.failed} THEN failures+1 ELSE 0 END
        WHERE github_user_id=${user} AND resource=${resource}`,
    apiClaim: (user: string, lease: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* sql<{
              locked: boolean;
            }>`SELECT pg_try_advisory_xact_lock(hashtext(${`github:${user}`})) AS locked`)[0]?.locked
          )
            return false;
          // An identity has at most one occupied slot, across accounts, owners and processes.
          yield* sql`UPDATE github_api_slots SET github_user_id=NULL,lease_id=NULL,lease_until=NULL WHERE lease_until<now()`;

          if ((yield* sql`SELECT slot FROM github_api_slots WHERE github_user_id=${user}`).length) return false;

          const slot = (yield* sql<{ slot: number }>`SELECT slot FROM github_api_slots WHERE github_user_id IS NULL
          ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1`)[0];

          if (!slot) return false;
          yield* sql`UPDATE github_api_slots SET github_user_id=${user},lease_id=${lease}::uuid,lease_until=now()+interval '60 seconds'
          WHERE slot=${slot.slot}`;

          return true;
        }),
      ),
    apiRelease: (lease: string) =>
      sql`UPDATE github_api_slots SET github_user_id=NULL,lease_id=NULL,lease_until=NULL WHERE lease_id=${lease}::uuid`,
    apiRenew: (lease: string) =>
      sql`UPDATE github_api_slots SET lease_until=now()+interval '60 seconds'
      WHERE lease_id=${lease}::uuid AND lease_until>now() RETURNING slot`,
  };
}
