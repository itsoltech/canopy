/** A heartbeat advances only for this thread, its inherited sources or shared metadata.
 * A pruned journal or changed epoch still forces a full validation at the home.
 * Batched parameters: owner, already-authorized thread ids, last examined journal revision.
 */
export const threadWatchRevision = `WITH clock AS MATERIALIZED (
  SELECT epoch,revision FROM computer_thread_clock WHERE owner_user_id=$1::uuid
), changes AS MATERIALIZED (
  SELECT computer_thread_changes.revision,thread_id FROM computer_thread_changes,clock
  WHERE owner_user_id=$1::uuid AND computer_thread_changes.revision>$3::bigint
    AND computer_thread_changes.revision<=clock.revision
), latest AS MATERIALIZED (
  SELECT thread_id,max(revision) AS revision FROM changes GROUP BY thread_id
)
SELECT t.id,c.epoch,c.revision::text,(SELECT count(*)::text FROM changes) AS count,
  coalesce((SELECT max(l.revision) FROM latest l
    WHERE l.thread_id IS NULL OR l.thread_id=ANY(s.ids)),0)::text AS relevant,
  EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=ANY(s.ids) AND
    (u.agent_call_id IS NOT NULL OR u.interaction_request_id IS NOT NULL OR u.schedule_id IS NOT NULL
      OR u.bot_call_id IS NOT NULL OR u.trigger='background_task'))
    OR EXISTS(SELECT 1 FROM agent_bus_calls a WHERE a.source_thread_id=t.id) AS broad
FROM threads t CROSS JOIN clock c CROSS JOIN LATERAL
  (SELECT array_agg(thread_id) AS ids FROM thread_fork_chain(t.id)) s
WHERE t.owner_user_id=$1::uuid AND t.id=ANY($2::uuid[])`;
