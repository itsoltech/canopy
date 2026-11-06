-- Bot history has separate storage from threads. Keep the same commit-ordered,
-- owner-scoped epoch/cursor design; the journal stores keys, never message text or credentials.
CREATE TABLE bot_view_clock (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO bot_view_clock(owner_user_id) SELECT id FROM users;
CREATE TABLE bot_view_changes (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  bot_id uuid NOT NULL,
  kind text NOT NULL,
  entity_id uuid,
  PRIMARY KEY(owner_user_id, revision)
);
CREATE INDEX bot_view_changes_bot ON bot_view_changes(owner_user_id,bot_id,revision);

CREATE FUNCTION bot_view_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; bot uuid; owner uuid; rev bigint; kind text; entity uuid;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  kind := TG_TABLE_NAME;
  entity := (data->>'id')::uuid;
  IF TG_TABLE_NAME='bots' THEN
    bot := entity;
    owner := (data->>'owner_user_id')::uuid;
    IF TG_OP<>'UPDATE' THEN kind := 'reset';
    ELSIF (to_jsonb(OLD)->'moved_to',to_jsonb(OLD)->'move_notes',to_jsonb(OLD)->'deleted_at')
      IS DISTINCT FROM (data->'moved_to',data->'move_notes',data->'deleted_at') THEN kind := 'reset'; END IF;
  ELSE
    bot := (data->>'bot_id')::uuid;
    IF TG_TABLE_NAME='bot_tool_calls' THEN
      SELECT bot_id INTO bot FROM bot_turns WHERE id=(data->>'turn_id')::uuid;
      kind := 'bot_turns';
      entity := (data->>'turn_id')::uuid;
    END IF;
    SELECT owner_user_id INTO owner FROM bots WHERE id=bot;
    IF TG_TABLE_NAME='bot_turns' AND TG_OP='UPDATE' AND
      (to_jsonb(OLD)->'reply_to_bot_id',to_jsonb(OLD)->'remote_recipient_ref',to_jsonb(OLD)->'exchange_id')
      IS DISTINCT FROM (data->'reply_to_bot_id',data->'remote_recipient_ref',data->'exchange_id') THEN kind := 'reset'; END IF;
  END IF;
  IF owner IS NULL THEN RETURN NULL; END IF;
  -- Deferred execution serializes journal allocation at commit, rather than sequence allocation.
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.bot_view_journal',0));
  INSERT INTO bot_view_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
  UPDATE bot_view_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
  INSERT INTO bot_view_changes VALUES(owner,rev,bot,kind,entity);
  IF rev % 1000 = 0 THEN
    DELETE FROM bot_view_changes WHERE owner_user_id=owner AND revision<=rev-10000;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bot_view_bot_change AFTER INSERT OR UPDATE OR DELETE ON bots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bot_view_changed();
CREATE CONSTRAINT TRIGGER bot_view_message_change AFTER INSERT OR UPDATE OR DELETE ON bot_messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bot_view_changed();
CREATE CONSTRAINT TRIGGER bot_view_turn_change AFTER INSERT OR UPDATE OR DELETE ON bot_turns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bot_view_changed();
CREATE CONSTRAINT TRIGGER bot_view_tool_change AFTER INSERT OR UPDATE OR DELETE ON bot_tool_calls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bot_view_changed();
