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
), watched AS MATERIALIZED (
  SELECT t.id,c.epoch,c.revision,
    CASE WHEN c.revision=$3::bigint THEN ARRAY[]::uuid[]
      ELSE ARRAY(SELECT thread_id FROM thread_fork_chain(t.id)) END AS ids
  FROM threads t CROSS JOIN clock c
  WHERE t.owner_user_id=$1::uuid AND t.id=ANY($2::uuid[])
)
SELECT c.id,c.epoch,c.revision::text,(SELECT count(*)::text FROM changes) AS count,
  coalesce((SELECT max(l.revision) FROM latest l
    WHERE l.thread_id IS NULL OR l.thread_id=ANY(c.ids)),0)::text AS relevant,
  CASE WHEN c.revision=$3::bigint THEN false ELSE
    EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=ANY(c.ids) AND
    (u.agent_call_id IS NOT NULL OR u.interaction_request_id IS NOT NULL OR u.schedule_id IS NOT NULL
      OR u.bot_call_id IS NOT NULL OR u.trigger='background_task'))
    OR EXISTS(SELECT 1 FROM agent_bus_calls a WHERE a.source_thread_id=c.id) END AS broad
FROM watched c`;
