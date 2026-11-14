import type { JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** The last known summary per owner and pull request, bound to the account that read it. */
export function githubPrSummaries(sql: SqlClient.SqlClient) {
  return {
    prRemember: (owner: string, id: string, account: string, summary: JsonValue) =>
      sql`UPDATE github_pull_requests SET summary=${JSON.stringify(summary)}::jsonb,summary_account_id=${account}::uuid,
        refresh_detail='' WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid`,
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
    prTouch: (owner: string, id: string) =>
      sql<{ id: string }>`UPDATE threads SET pull_request_revision=pull_request_revision+1
        WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL AND id IN (SELECT thread_id FROM thread_pull_requests
          WHERE owner_user_id=${owner}::uuid AND pull_request_id=${id}::uuid AND unlinked_at IS NULL) RETURNING id`,
    cacheInvalidateRepository: (owner: string, account: string, repo: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${owner}::uuid AND account_id=${account}::uuid
            AND cache_key LIKE ${`%:${repo}:%`}`;
          yield* sql`UPDATE github_pull_requests SET summary=NULL,summary_account_id=NULL
            WHERE owner_user_id=${owner}::uuid AND repository_id=${repo} AND summary_account_id=${account}::uuid`;
        }),
      ),
  };
}
