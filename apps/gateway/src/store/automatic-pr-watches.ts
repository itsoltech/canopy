import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";

export const automaticPrNotificationsEnabled = (sql: SqlClient.SqlClient, thread: Statement.Fragment) => sql`EXISTS (
  SELECT 1 FROM threads t
  LEFT JOIN project_settings ps ON ps.project_id=t.project_id
  LEFT JOIN user_settings us ON us.user_id=t.owner_user_id
  WHERE t.id=${thread} AND coalesce(
    (ps.settings #>> '{threadDefaults,notifyOnLinkedPullRequests}')::boolean,
    (us.settings #>> '{threadDefaults,notifyOnLinkedPullRequests}')::boolean, true))`;

/** Called in the same transaction as the link. Rediscovery preserves the watch's progress. */
export const watchNewPullRequestLink = (
  sql: SqlClient.SqlClient,
  owner: string,
  thread: string,
  pullRequest: string,
  state: string | undefined,
  head: string,
) => {
  if (state === "merged" || state === "closed") return Effect.void;

  return sql`INSERT INTO pr_check_watches (id,owner_user_id,thread_id,pull_request_id,notify_on,hops,head_sha)
    SELECT ${Bun.randomUUIDv7()}::uuid,t.owner_user_id,t.id,${pullRequest}::uuid,ARRAY['complete'],1,${head}
    FROM threads t WHERE t.owner_user_id=${owner}::uuid AND t.id=${thread}::uuid
      AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.moved_to IS NULL AND t.purged_at IS NULL
    ON CONFLICT (owner_user_id,thread_id,pull_request_id) WHERE call_id IS NULL AND status='active' DO NOTHING`.pipe(
    Effect.asVoid,
  );
};

export const unlinkAutomaticPrWatch = (sql: SqlClient.SqlClient, owner: string, thread: string, pullRequest: string) =>
  sql`WITH ended AS (
    UPDATE pr_check_watches SET status='ended',end_reason='unlinked',ended_at=now(),updated_at=now()
    WHERE owner_user_id=${owner}::uuid AND thread_id=${thread}::uuid AND pull_request_id=${pullRequest}::uuid
      AND call_id IS NULL AND status='active' RETURNING id
  ) UPDATE pr_check_notes SET status='cancelled',reason='watch unlinked',updated_at=now()
    WHERE watch_id IN (SELECT id FROM ended) AND status='waiting'`;
