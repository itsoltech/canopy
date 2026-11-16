import type { SqlClient } from "effect/sql";
import { ALL_LINKS_MERGED, MERGE_ARCHIVE_SCOPE } from "../store/thread-merge-archive.ts";

/** Database discovery survives idle clients, gateway restarts and expired producer leases. */
export function githubMergeArchiveStore(sql: SqlClient.SqlClient) {
  return {
    mergeArchiveThreads: (owner: string) =>
      sql.unsafe<{ id: string }>(`SELECT t.id ${MERGE_ARCHIVE_SCOPE} AND ${ALL_LINKS_MERGED} ORDER BY t.id`, [owner]),
    mergeArchivePullRequests: (owner: string) =>
      sql.unsafe<{ id: string; refresh: boolean }>(
        `SELECT DISTINCT l.pull_request_id AS id,
          (pr.summary IS NULL OR pr.refresh_detail<>'' OR
            pr.summary_account_id IS DISTINCT FROM (SELECT r.account_id FROM github_repository_accounts r
              WHERE r.owner_user_id=pr.owner_user_id AND r.repository_id=pr.repository_id)) AS refresh
        FROM thread_pull_requests l
        JOIN github_pull_requests pr ON pr.owner_user_id=l.owner_user_id AND pr.id=l.pull_request_id
        WHERE l.owner_user_id=$1::uuid AND l.unlinked_at IS NULL AND l.thread_id IN (
          SELECT t.id ${MERGE_ARCHIVE_SCOPE})
        AND (pr.summary->>'state' IS DISTINCT FROM 'merged' OR pr.refresh_detail<>'' OR
          pr.summary_account_id IS DISTINCT FROM (SELECT r.account_id FROM github_repository_accounts r
            WHERE r.owner_user_id=pr.owner_user_id AND r.repository_id=pr.repository_id))
        ORDER BY l.pull_request_id`,
        [owner],
      ),
  };
}
