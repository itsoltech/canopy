-- Read-only bot projections: never used by the runtime or tool dispatcher.
-- Each home retains its local tree fragment; remote lineage is an explicit reference,
-- never a fake local parent row. Existing local lineage constraints stay intact.
ALTER TABLE threads ADD COLUMN remote_parent_ref text;
ALTER TABLE threads ADD COLUMN remote_parent_kind text CHECK (remote_parent_kind IN ('thread', 'bot'));
ALTER TABLE threads ADD COLUMN remote_parent_detached boolean NOT NULL DEFAULT false;
ALTER TABLE threads DROP CONSTRAINT threads_parent_route;
ALTER TABLE threads ADD CONSTRAINT threads_parent_route CHECK (interaction_route = 'human' OR kind = 'side' OR remote_parent_ref IS NOT NULL);
ALTER TABLE bot_turns ADD COLUMN remote_recipient_ref text;
ALTER TABLE bot_tool_calls ADD COLUMN linked_remote boolean NOT NULL DEFAULT false;
-- Remote calls have no local agent_bus_calls/bot_tool_calls foreign key.
ALTER TABLE turns ADD COLUMN linked_call_id uuid;
ALTER TABLE turns DROP CONSTRAINT turns_trigger_check;
ALTER TABLE turns ADD CONSTRAINT turns_trigger_check CHECK (trigger IN ('user','agent_bus','schedule','interaction','goal','provider','recovery','background_task','bot','linked_agent'));
ALTER TABLE turns DROP CONSTRAINT turns_hops_by_trigger;
ALTER TABLE turns ADD CONSTRAINT turns_hops_by_trigger CHECK (
  (trigger IN ('user','goal','provider','recovery') AND hops = 0)
  OR (trigger IN ('agent_bus','background_task','bot','linked_agent') AND hops > 0)
  OR trigger IN ('schedule','interaction')
);
ALTER TABLE turns ADD CONSTRAINT turns_linked_call CHECK ((trigger = 'linked_agent') = (linked_call_id IS NOT NULL));
ALTER TABLE turn_steers ADD COLUMN linked_call_id uuid;
ALTER TABLE turn_steers DROP CONSTRAINT turn_steers_author;
ALTER TABLE turn_steers ADD CONSTRAINT turn_steers_author CHECK (
  CASE WHEN background_note THEN num_nonnulls(author_user_id, agent_call_id, notification_call_id, bot_call_id, linked_call_id) = 0
       ELSE num_nonnulls(author_user_id, agent_call_id, notification_call_id, bot_call_id, linked_call_id) = 1 END
);
CREATE TABLE computer_bot_mirror_state (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  cursor text NOT NULL,
  PRIMARY KEY (owner_user_id, origin_node_id),
  FOREIGN KEY (owner_user_id, origin_node_id) REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);
CREATE TABLE computer_mirror_bots (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  bot_id uuid NOT NULL,
  snapshot bytea NOT NULL,
  PRIMARY KEY (owner_user_id, origin_node_id, bot_id),
  FOREIGN KEY (owner_user_id, origin_node_id) REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);

-- Cross-boundary references deliberately have no foreign keys to remote entities.
-- Unlink preserves the reference and removes its routing authority atomically.
CREATE TABLE computer_agent_calls (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  peer_node_id text NOT NULL,
  call_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('thread', 'bot')),
  source_routine_id uuid,
  source_routine_title text NOT NULL DEFAULT '',
  target_id uuid,
  target_kind text CHECK (target_kind IN ('thread', 'bot')),
  target_turn_id uuid,
  target_steer_id uuid,
  operation text NOT NULL,
  result jsonb,
  hops integer NOT NULL CHECK (hops BETWEEN 0 AND 8),
  notify boolean NOT NULL DEFAULT true,
  parent_link boolean NOT NULL DEFAULT false,
  detached boolean NOT NULL DEFAULT false,
  report_status text NOT NULL DEFAULT 'pending' CHECK (report_status IN ('pending', 'delivered', 'dropped')),
  PRIMARY KEY (owner_user_id, peer_node_id, call_id, direction)
);
CREATE INDEX computer_agent_pending_reports ON computer_agent_calls(owner_user_id,target_turn_id)
  WHERE direction='incoming' AND notify AND NOT detached AND report_status='pending';
CREATE FUNCTION detach_computer_agents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE threads SET remote_parent_detached = true
    WHERE owner_user_id = OLD.owner_user_id AND remote_parent_ref LIKE '%~' || left(OLD.node_id, 16);
  UPDATE computer_agent_calls SET detached = true, report_status = 'dropped'
    WHERE owner_user_id = OLD.owner_user_id AND peer_node_id = OLD.node_id;
  RETURN OLD;
END $$;
CREATE TRIGGER computer_agents_unlink BEFORE DELETE ON computer_peers
  FOR EACH ROW EXECUTE FUNCTION detach_computer_agents();

CREATE TABLE computer_agent_events (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  peer_node_id text NOT NULL,
  call_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY(owner_user_id,peer_node_id,call_id,event_id)
);
