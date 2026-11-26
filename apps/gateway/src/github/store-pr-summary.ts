import type { JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { lockGitHubCache } from "./store-cache.ts";

/** The last known summary per owner and pull request, bound to the account that read it. */
export function githubPrSummaries(sql: SqlClient.SqlClient) {
  return {
    prRemember: (owner: string, id: string, account: string, summary: JsonValue, revision: bigint) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const payload = JSON.stringify(summary);

          // Invalidation deletes the cache row before clearing the summary. Lock it before writing.
          const source = yield* sql`SELECT 1 FROM github_pull_requests p
            JOIN github_repository_accounts r USING(owner_user_id,repository_id)
            JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id
            JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
              AND c.cache_key='summary:'||p.repository_id||':'||p.number
            WHERE p.owner_user_id=${owner}::uuid AND p.id=${id}::uuid AND a.id=${account}::uuid
              AND a.status='connected' AND a.revision=${revision}::bigint AND c.payload->'summary'=${payload}::jsonb
              AND c.payload->>'completeness' IS DISTINCT FROM 'partial' FOR SHARE OF c`;

          if (!source.length) return [];

          return yield* sql`UPDATE github_pull_requests SET summary=${payload}::jsonb,summary_account_id=${account}::uuid,
            refresh_detail='' WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`;
        }),
      ),
    /** Lost access also drops the last known summary: private content is not shown without access. */
    prRefreshFailed: (owner: string, name: string, number: number, detail: string, forget: boolean) =>
      sql<{ id: string }>`UPDATE github_pull_requests SET refresh_detail=${detail},refreshed_at=now(),
        summary=CASE WHEN ${forget} THEN NULL ELSE summary END,
        summary_account_id=CASE WHEN ${forget} THEN NULL ELSE summary_account_id END
        WHERE owner_user_id=${owner}::uuid AND lower(repository_name)=lower(${name}) AND number=${number} RETURNING id`,
    /** One refresh per pull request and interval across gateway processes; a failed one is not retried in a loop. */
    prRefreshClaim: (owner: string, id: string) =>
      sql<{ id: string }>`UPDATE github_pull_requests SET refreshed_at=now() WHERE owner_user_id=${owner}::uuid
        AND id=${id}::uuid AND (refreshed_at IS NULL OR refreshed_at<now()-interval '5 minutes') RETURNING id`,
    cacheInvalidateRepository: (owner: string, account: string, repo: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lockGitHubCache(sql, owner);
          yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid
            AND cache_key LIKE ${`%:${repo}:%`}`;
          yield* sql`UPDATE github_pull_requests SET summary=NULL,summary_account_id=NULL
            WHERE owner_user_id=${owner}::uuid AND repository_id=${repo} AND summary_account_id=${account}::uuid`;
        }),
      ),
  };
}
