import type { SqlClient } from "effect/sql";

/** Only the selected, connected account's current access revision can supply a citation. No network path. */
export function githubCitations(sql: SqlClient.SqlClient) {
  return {
    citationCache: (owner: string, thread: string, pr: string, kind: string, resource: string) => {
      const probe =
        kind === "comment" || kind === "review"
          ? { items: [{ [kind]: { id: resource } }] }
          : kind === "review_comment"
            ? { threads: [{ comments: [{ id: resource }] }] }
            : kind === "check"
              ? { checks: [{ nodeId: resource }] }
              : kind === "job"
                ? { jobs: [{ id: resource }] }
                : {};

      const prefix =
        kind === "review_comment"
          ? "reviews"
          : kind === "comment" || kind === "review"
            ? "timeline"
            : kind === "check"
              ? "checks"
              : kind === "job"
                ? "jobs"
                : "logs";

      return sql<{
        repository_name: string;
        number: number;
        serialized_payload: string;
        verified_at: Date;
        source_url: string | null;
        cache_kind: string;
      }>`
        SELECT p.repository_name,p.number,c.payload::text AS serialized_payload,c.verified_at,split_part(c.cache_key,':',1) AS cache_kind,
          (SELECT j.payload->>'html_url' FROM github_pr_cache j
            WHERE j.owner_user_id=c.owner_user_id AND j.account_id=c.account_id AND j.access_revision=c.access_revision
            AND j.cache_key='job:'||p.repository_id||':'||split_part(c.cache_key,':',4)||':'||${resource}
            AND j.payload->>'run_attempt'=split_part(c.cache_key,':',6)) AS source_url
        FROM github_pull_requests p
        JOIN thread_pull_requests l ON l.owner_user_id=p.owner_user_id AND l.pull_request_id=p.id
        JOIN threads t ON t.owner_user_id=l.owner_user_id AND t.id=l.thread_id AND t.deleted_at IS NULL
        JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
        JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
        JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
        WHERE p.owner_user_id=${owner}::uuid AND p.id=${pr}::uuid AND l.thread_id=${thread}::uuid AND l.unlinked_at IS NULL
        AND ((a.auth_kind='pat' AND EXISTS(SELECT 1 FROM connector_accounts ca
          WHERE ca.owner_user_id=a.owner_user_id AND ca.id=a.connector_account_id AND ca.revision=a.connector_revision
          AND ca.status='connected' AND ca.connector_type='github' AND ca.auth_kind='headers'
          AND ca.url='https://api.githubcopilot.com/mcp/')) OR EXISTS(SELECT 1 FROM github_installation_repositories ir
          JOIN github_installations i USING(owner_user_id,account_id,installation_id)
          WHERE ir.owner_user_id=a.owner_user_id AND ir.account_id=a.id AND ir.repository_id=p.repository_id AND NOT i.suspended))
        AND (c.cache_key LIKE ${prefix + ":"}||p.repository_id||':'||p.number||':%'
          OR (${kind === "check"} AND c.cache_key='summary:'||p.repository_id||':'||p.number)
          OR (${kind === "review_comment"} AND c.cache_key LIKE 'pending:'||p.repository_id||':'||p.number||':%'))
        AND (c.payload @> ${JSON.stringify(probe)}::jsonb
          OR (${kind === "review_comment"} AND c.payload @> ${JSON.stringify({ comments: [{ comment: { id: resource } }] })}::jsonb)
          OR (${kind === "check"} AND (c.payload @> ${JSON.stringify({ checks: [{ url: resource }] })}::jsonb
            OR c.payload @> ${JSON.stringify({ checks: [{ name: resource }] })}::jsonb)))
        AND (${kind !== "log"} OR split_part(c.cache_key,':',5)=${resource})
        ORDER BY c.verified_at DESC LIMIT 1`;
    },
  };
}
