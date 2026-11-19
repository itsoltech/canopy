-- Linked list entries can change without changing a thread's newest PR.
ALTER TABLE thread_pull_requests ADD COLUMN projected_summary_hash bytea;

CREATE VIEW github_pr_projection_summaries AS
SELECT v.owner_user_id,v.id,v.created_at,v.summary,
  sha256(convert_to(jsonb_build_array(v.account_id,v.access_revision,v.summary - 'verifiedAt')::text,'UTF8')) AS summary_hash
FROM (
  SELECT p.owner_user_id,p.id,p.created_at,a.id AS account_id,a.revision AS access_revision,
    coalesce(c.payload->'summary',CASE WHEN p.summary_account_id=a.id THEN p.summary END) AS summary
  FROM github_pull_requests p
  LEFT JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
  LEFT JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
  LEFT JOIN github_pr_cache c ON c.owner_user_id=a.owner_user_id AND c.account_id=a.id AND c.access_revision=a.revision
    AND c.cache_key='summary:'||p.repository_id||':'||p.number
) v;

-- Retain the currently visible baseline across an upgrade without moving the link/unlink fence.
UPDATE thread_pull_requests l SET projected_summary_hash=s.summary_hash
FROM github_pr_projection_summaries s
WHERE s.owner_user_id=l.owner_user_id AND s.id=l.pull_request_id AND l.unlinked_at IS NULL;
