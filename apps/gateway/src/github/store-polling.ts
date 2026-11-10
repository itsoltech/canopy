import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "./records.ts";
import type { PullRequestRow } from "./store-pull-requests.ts";

export function githubPollingStore(sql: SqlClient.SqlClient) {
  return {
    pollCandidates: (owner: string) => sql<PullRequestRow>`SELECT DISTINCT p.* FROM github_pull_requests p
      JOIN thread_pull_requests l ON l.owner_user_id=p.owner_user_id AND l.pull_request_id=p.id AND l.unlinked_at IS NULL
      JOIN threads t ON t.owner_user_id=l.owner_user_id AND t.id=l.thread_id
      JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
      JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
      JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
        AND c.cache_key='summary:'||p.repository_id||':'||p.number
      WHERE p.owner_user_id=${owner}::uuid AND t.deleted_at IS NULL AND t.archived_at IS NULL
      AND c.payload->'summary'->>'state' IN ('open','draft') AND (
        EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('running','queued')) OR
        EXISTS(SELECT 1 FROM github_git_contexts g WHERE g.owner_user_id=t.owner_user_id AND g.thread_id=t.id
          AND g.observed_at>now()-interval '15 minutes'))
      ORDER BY p.repository_name,p.number LIMIT 100`,
    cacheHeader: (row: AccountRow, repository: string, number: number, summary: Schema.JsonObject) =>
      sql.withTransaction(
        Effect.gen(function* () {
          return yield* sql`UPDATE github_pr_cache c SET payload=jsonb_set(jsonb_set(
          CASE WHEN c.payload->'summary'->>'headSha' IS DISTINCT FROM ${summary["headSha"]}::text
            THEN jsonb_set(c.payload,'{checks}','[]'::jsonb) ELSE c.payload END,'{summary}',${JSON.stringify(summary)}::jsonb),
          '{stale}','true'::jsonb),expires_at=least(c.expires_at,now()),generation=generation+1
          WHERE owner_user_id=${row.owner_user_id}::uuid AND account_id=${row.id}::uuid AND access_revision=${row.revision}::bigint
          AND cache_key=${`summary:${repository}:${number}`} AND payload IS NOT NULL
          AND payload->'summary' IS DISTINCT FROM ${JSON.stringify(summary)}::jsonb
          AND EXISTS(SELECT 1 FROM github_accounts a WHERE a.owner_user_id=c.owner_user_id AND a.id=c.account_id
            AND a.revision=c.access_revision AND a.status='connected')
          AND EXISTS(SELECT 1 FROM github_repository_accounts r WHERE r.owner_user_id=c.owner_user_id
            AND r.repository_id=${repository} AND r.account_id=c.account_id)`;
        }),
      ),
  };
}
