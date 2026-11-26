ALTER TABLE bot_channel_routes ADD COLUMN channel_context boolean NOT NULL DEFAULT true;
ALTER TABLE bot_turns ADD COLUMN slack_context_epoch bigint,
  ADD COLUMN slack_context_sources text[];
-- NULL provenance marks a reply generated without a snapshot from this projection.

-- Conversation notes written after opt-out start with the new conversation history.
ALTER TABLE agent_memory_scopes ADD COLUMN slack_context_epoch bigint;
ALTER TABLE agent_memory_scopes ALTER COLUMN scope_key SET EXPRESSION AS (
  CASE WHEN worker_id IS NOT NULL THEN 'worker:' || project_id::text || ':' || worker_id::text
       WHEN project_id IS NOT NULL THEN 'project:' || project_id::text
       WHEN conversation_id IS NOT NULL THEN 'conversation:' || bot_id::text || ':' || conversation_id::text
         || coalesce(':' || slack_context_epoch::text, '')
       ELSE 'bot:' || bot_id::text END
);

-- Keep scopes after opt-out so previous channel transcripts cannot be resumed.
CREATE TABLE slack_channel_contexts (
  route_id uuid NOT NULL REFERENCES bot_channel_routes(id),
  channel_id text NOT NULL,
  epoch bigint NOT NULL DEFAULT 1,
  head bigint NOT NULL DEFAULT 0,
  cursor bigint NOT NULL DEFAULT 0,
  next_analysis_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_id uuid,
  lease_until timestamptz,
  PRIMARY KEY (route_id, channel_id)
);

CREATE TABLE slack_channel_context_messages (
  route_id uuid NOT NULL,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  thread_id text NOT NULL,
  slack_ts numeric NOT NULL,
  edited_ts numeric,
  author_id text NOT NULL,
  text text NOT NULL,
  own_reply boolean NOT NULL DEFAULT false,
  reply_sources text[] NOT NULL DEFAULT '{}',
  deleted boolean NOT NULL DEFAULT false,
  change_no bigint NOT NULL,
  PRIMARY KEY (route_id, channel_id, message_id),
  FOREIGN KEY (route_id, channel_id) REFERENCES slack_channel_contexts ON DELETE CASCADE
);
CREATE INDEX slack_context_changes ON slack_channel_context_messages (route_id, channel_id, change_no);
CREATE INDEX slack_context_recent ON slack_channel_context_messages (route_id, channel_id, slack_ts DESC) WHERE NOT deleted;
CREATE INDEX slack_context_reply_sources ON slack_channel_context_messages USING gin(reply_sources) WHERE own_reply AND NOT deleted;
CREATE INDEX slack_context_thread ON slack_channel_context_messages (route_id, channel_id, (coalesce(nullif(thread_id,''),message_id)), slack_ts DESC) WHERE NOT deleted;

CREATE TABLE slack_channel_topics (
  route_id uuid NOT NULL,
  channel_id text NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL,
  aliases text[] NOT NULL,
  summary text NOT NULL,
  is_open boolean NOT NULL,
  source_ids text[] NOT NULL,
  roots text[] NOT NULL,
  authors text[] NOT NULL,
  -- Includes every message visible to the generation, including the lineage of any previous topics.
  dependencies text[] NOT NULL,
  search tsvector NOT NULL,
  activity numeric NOT NULL,
  PRIMARY KEY (route_id, channel_id, id),
  FOREIGN KEY (route_id, channel_id) REFERENCES slack_channel_contexts ON DELETE CASCADE
);
CREATE INDEX slack_topics_search ON slack_channel_topics USING gin(search);
CREATE INDEX slack_topics_recent ON slack_channel_topics (route_id, channel_id, is_open DESC, activity DESC);
CREATE INDEX slack_topics_dependencies ON slack_channel_topics USING gin(dependencies);

-- Give affected surviving evidence a new change number without rewinding unrelated work.
CREATE FUNCTION reschedule_slack_context(route uuid, channel text, ids text[], corrected text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  WITH ranked AS (
    SELECT m.message_id,s.head+row_number() OVER (ORDER BY m.message_id IS NOT DISTINCT FROM corrected,m.change_no) AS next_change
    FROM slack_channel_context_messages m JOIN slack_channel_contexts s USING (route_id,channel_id)
    WHERE m.route_id=route AND m.channel_id=channel AND NOT m.deleted
      AND ((m.change_no<=s.cursor AND m.message_id=ANY(ids)) OR m.message_id=corrected)
  ), moved AS (
    UPDATE slack_channel_context_messages m SET change_no=ranked.next_change FROM ranked
    WHERE m.route_id=route AND m.channel_id=channel AND m.message_id=ranked.message_id
    RETURNING m.change_no
  )
  UPDATE slack_channel_contexts s SET head=coalesce((SELECT max(change_no) FROM moved),s.head)
  WHERE s.route_id=route AND s.channel_id=channel;
$$;

-- Invalidate any published replies that used the outdated evidence, including through another reply.
CREATE FUNCTION invalidate_slack_context_sources(route uuid, channel text, stale text[], corrected text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  WITH RECURSIVE affected(id) AS (
    SELECT unnest(stale)
    UNION
    SELECT m.message_id FROM affected a JOIN slack_channel_context_messages m
      ON m.reply_sources @> ARRAY[a.id]
    WHERE m.route_id=route AND m.channel_id=channel AND m.own_reply AND NOT m.deleted
  ), invalidated_replies AS (
    UPDATE slack_channel_context_messages SET deleted=true,text='',reply_sources='{}'
    WHERE route_id=route AND channel_id=channel AND message_id IN (SELECT id FROM affected)
      AND own_reply AND NOT (message_id=ANY(stale))
  ), invalidated_topics AS (
    DELETE FROM slack_channel_topics WHERE route_id=route AND channel_id=channel
      AND dependencies && ARRAY(SELECT id FROM affected)
    RETURNING dependencies
  )
  SELECT reschedule_slack_context(route, channel, ARRAY(SELECT DISTINCT unnest(dependencies) FROM invalidated_topics
    EXCEPT SELECT id FROM affected), corrected)
  WHERE EXISTS (SELECT FROM invalidated_topics);
$$;

-- The caller serializes with Socket Mode and dispatch by holding the messenger account.
CREATE FUNCTION reset_slack_context(route uuid, channel text, removed_authors text[] DEFAULT NULL, reset_buffer boolean DEFAULT true)
RETURNS void LANGUAGE sql AS $$
  UPDATE slack_channel_contexts SET epoch=epoch+1,
    cursor=CASE WHEN removed_authors IS NULL THEN head ELSE cursor END,
    next_analysis_at='-infinity'
  WHERE route_id=route AND channel_id=channel;

  UPDATE slack_channel_context_messages SET deleted=true,text='',reply_sources='{}'
  WHERE route_id=route AND channel_id=channel AND NOT deleted
    AND (removed_authors IS NULL OR author_id=ANY(removed_authors));

  UPDATE bot_channel_messages m SET deleted=true,slack_file_ids='{}'
  FROM bot_channel_conversations c
  WHERE c.route_id=route AND c.channel_id=channel AND m.conversation_id=c.id
    AND reset_buffer AND m.state IN ('buffered','attempted') AND NOT m.deleted
    AND (removed_authors IS NULL OR m.author_id=ANY(removed_authors));

  DELETE FROM slack_channel_topics WHERE route_id=route AND channel_id=channel AND removed_authors IS NULL;

  SELECT invalidate_slack_context_sources(route, channel, ARRAY(
    SELECT message_id FROM slack_channel_context_messages WHERE route_id=route AND channel_id=channel
      AND author_id=ANY(removed_authors)))
  WHERE removed_authors IS NOT NULL;
$$;

CREATE FUNCTION sync_slack_route_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  channel text;
  removed text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT ARRAY(SELECT unnest(OLD.user_ids) EXCEPT SELECT unnest(NEW.user_ids)) INTO removed;
    FOR channel IN SELECT channel_id FROM slack_channel_contexts WHERE route_id=NEW.id ORDER BY channel_id LOOP
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
        OR channel=ANY(OLD.channel_ids) AND NOT channel=ANY(NEW.channel_ids) THEN
        PERFORM reset_slack_context(NEW.id, channel);
      ELSIF OLD.channel_context IS DISTINCT FROM NEW.channel_context THEN
        PERFORM reset_slack_context(NEW.id, channel, NULL, false);
      ELSIF cardinality(removed)>0 THEN
        PERFORM reset_slack_context(NEW.id, channel, removed);
      END IF;
    END LOOP;
  END IF;

  IF NEW.channel_context AND NEW.deleted_at IS NULL THEN
    INSERT INTO slack_channel_contexts(route_id, channel_id)
      SELECT NEW.id, listed.id FROM unnest(NEW.channel_ids) AS listed(id)
      WHERE listed.id ~ '^[CG][A-Z0-9]{1,79}$' ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_slack_route_context
  AFTER INSERT OR UPDATE OF channel_context, channel_ids, user_ids, deleted_at ON bot_channel_routes
  FOR EACH ROW EXECUTE FUNCTION sync_slack_route_context();

CREATE FUNCTION reset_unavailable_slack_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reset_slack_context(s.route_id, s.channel_id)
    FROM slack_channel_contexts s JOIN bot_channel_routes r ON r.id=s.route_id
    WHERE r.account_id=NEW.id ORDER BY s.route_id,s.channel_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reset_unavailable_slack_account
  AFTER UPDATE OF enabled, deleted_at, revision, status ON messenger_accounts FOR EACH ROW
  WHEN (OLD.enabled AND NOT NEW.enabled OR OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    OR OLD.revision <> NEW.revision
    OR OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('needs_authorization','needs_reconnect','disconnected'))
  EXECUTE FUNCTION reset_unavailable_slack_account();

CREATE FUNCTION capture_slack_turn_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT s.epoch INTO NEW.slack_context_epoch
    FROM bot_channel_conversations c JOIN slack_channel_contexts s USING (route_id,channel_id)
    WHERE c.id=NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_slack_turn_epoch
  BEFORE INSERT ON bot_turns FOR EACH ROW WHEN (NEW.conversation_id IS NOT NULL)
  EXECUTE FUNCTION capture_slack_turn_epoch();

-- Start capture at upgrade. Archived or disconnected subscriptions already have a scope
-- when the owner reactivates them. Runtime admission decides when they can use it.
INSERT INTO slack_channel_contexts(route_id, channel_id)
  SELECT DISTINCT r.id, channel FROM bot_channel_routes r CROSS JOIN LATERAL unnest(r.channel_ids) AS channel
  WHERE r.deleted_at IS NULL AND channel ~ '^[CG][A-Z0-9]{1,79}$';

-- Keep work accepted by the old gateway when its Slack input is still verifiable. An
-- unstarted turn uses only its current input. An acknowledged harness or a pending reply may
-- have seen earlier conversation messages, so those must also still be eligible.
WITH candidates AS (
  SELECT t.id,c.id AS conversation_id,s.epoch,r.user_ids,
    (t.status IN ('queued','running') AND t.checkpoint='[]'::jsonb AND h.turn_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_tool_calls a WHERE a.turn_id=t.id)) AS fresh,
    coalesce(w.status='completed',false) AS acknowledged,
    coalesce(o.status='pending',false) AS pending_reply
  FROM bot_turns t JOIN bot_channel_conversations c ON c.id=t.conversation_id
  JOIN slack_channel_contexts s USING (route_id,channel_id)
  JOIN bot_channel_routes r ON r.id=c.route_id AND r.bot_id=t.bot_id
  LEFT JOIN bot_harness_turns h ON h.turn_id=t.id
  LEFT JOIN worker_commands w ON w.id=h.command_id
  LEFT JOIN messenger_outbound o ON o.turn_id=t.id
  WHERE t.status IN ('queued','running','waiting') OR (t.status='completed' AND o.status='pending')
), resumable AS (
  SELECT p.id,p.epoch FROM candidates p
  WHERE (p.fresh OR p.acknowledged OR p.pending_reply)
  AND EXISTS (
    SELECT 1 FROM bot_channel_inputs i JOIN bot_channel_messages m ON m.input_id=i.id
      AND m.conversation_id=i.conversation_id
    WHERE i.turn_id=p.id AND i.conversation_id=p.conversation_id AND i.status='applied'
  )
  AND NOT EXISTS (
    SELECT 1 FROM bot_channel_inputs i JOIN bot_channel_messages m ON m.input_id=i.id
      AND m.conversation_id=i.conversation_id
    WHERE i.conversation_id=p.conversation_id AND i.status IN ('applied','attempted')
      AND (NOT p.fresh OR i.turn_id=p.id)
      AND (m.deleted OR m.source_edited OR NOT (m.author_id=ANY(p.user_ids)))
  )
)
UPDATE bot_turns t SET slack_context_epoch=p.epoch FROM resumable p WHERE t.id=p.id;
