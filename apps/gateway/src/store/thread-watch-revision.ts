/** A heartbeat advances only for this thread, its inherited sources or shared metadata.
 * A pruned journal or changed epoch still forces a full validation at the home.
 * Parameters: owner, thread, checkpoint epoch (or null), checkpoint revision (or null).
 */
export const threadWatchRevision = `WITH clock AS (
  SELECT epoch,revision FROM computer_thread_clock WHERE owner_user_id=$1::uuid
), chain AS MATERIALIZED (SELECT thread_id FROM thread_fork_chain($2::uuid)), relevant AS (
  SELECT max(revision) AS revision FROM computer_thread_changes
  WHERE owner_user_id=$1::uuid AND revision>$4::bigint
    AND (thread_id IS NULL OR thread_id IN (SELECT thread_id FROM chain))
)
SELECT clock.epoch, (CASE WHEN $3::text IS DISTINCT FROM clock.epoch::text OR $4::bigint IS NULL
    OR $4::bigint < coalesce((SELECT min(revision) FROM computer_thread_changes WHERE owner_user_id=$1::uuid),clock.revision)-1
    OR EXISTS(SELECT 1 FROM turns WHERE thread_id IN (SELECT thread_id FROM chain) AND
      (agent_call_id IS NOT NULL OR interaction_request_id IS NOT NULL OR schedule_id IS NOT NULL
        OR bot_call_id IS NOT NULL OR trigger='background_task') LIMIT 1)
  THEN clock.revision ELSE greatest($4::bigint,coalesce(relevant.revision,$4::bigint)) END)::text AS revision
FROM clock CROSS JOIN relevant`;
