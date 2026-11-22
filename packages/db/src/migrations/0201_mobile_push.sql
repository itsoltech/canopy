CREATE TABLE mobile_push_subscriptions (
  device_id uuid PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL,
  registration_hash bytea NOT NULL,
  encrypted_token bytea NOT NULL,
  encrypted_preview_key bytea NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE mobile_push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('turn', 'interaction', 'message', 'approval')),
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  ticket_id text,
  UNIQUE (registration_id, event_kind, event_id)
);
CREATE INDEX mobile_push_due ON mobile_push_outbox (owner_user_id, next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX mobile_push_cleanup ON mobile_push_outbox (owner_user_id, created_at);

-- Snooze applies to user-created side threads as well as the thread that was snoozed.
CREATE FUNCTION mobile_push_thread_muted(p_thread_id uuid, p_owner_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  -- threads_max_depth limits side threads to one level.
  SELECT EXISTS (
    SELECT 1
    FROM threads target
    JOIN threads candidate ON candidate.id IN (target.id, target.parent_thread_id)
      AND candidate.owner_user_id = target.owner_user_id
    WHERE target.id = p_thread_id AND target.owner_user_id = p_owner_id
      AND candidate.snoozed AND (candidate.snoozed_until IS NULL OR candidate.snoozed_until > statement_timestamp())
      AND candidate.archived_at IS NULL AND candidate.deleted_at IS NULL AND candidate.moved_to IS NULL
  );
$$;

-- Insert in the same transaction as the domain event. No content is copied into the outbox.
CREATE FUNCTION enqueue_mobile_push() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  destination uuid;
  event_type text := TG_ARGV[0];
  module_id text;
BEGIN
  IF event_type IN ('turn', 'interaction') THEN
    destination := NEW.thread_id;
    module_id := 'threads';
    SELECT owner_user_id INTO owner_id FROM threads WHERE id = destination
      AND archived_at IS NULL AND deleted_at IS NULL AND moved_to IS NULL AND origin <> 'agent'
      AND NOT mobile_push_thread_muted(id, owner_user_id);
  ELSE
    destination := NEW.bot_id;
    module_id := 'bots';
    SELECT owner_user_id INTO owner_id FROM bots WHERE id = destination
      AND archived_at IS NULL AND deleted_at IS NULL AND moved_to IS NULL;
  END IF;

  IF owner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_settings WHERE user_id = owner_id
      AND NOT (coalesce(settings #> '{modules,enabled}', '["threads","bots"]'::jsonb) ? module_id)
  ) THEN
    INSERT INTO mobile_push_outbox (device_id, registration_id, owner_user_id, destination_id, event_kind, event_id)
      SELECT d.id, s.registration_id, owner_id, destination, event_type, NEW.id
      FROM mobile_devices d JOIN mobile_push_subscriptions s ON d.id = s.device_id
      WHERE d.owner_user_id = owner_id AND d.client_kind = 'mobile' AND d.revoked_at IS NULL AND s.expires_at > now()
      ON CONFLICT (registration_id, event_kind, event_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER mobile_push_turn AFTER UPDATE OF status ON turns FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND (NEW.status IN ('completed', 'failed')
    OR (NEW.status = 'interrupted' AND NEW.interrupt_source IS DISTINCT FROM 'user')))
  EXECUTE FUNCTION enqueue_mobile_push('turn');

CREATE TRIGGER mobile_push_interaction AFTER INSERT ON interaction_requests FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.routed_to = 'human')
  EXECUTE FUNCTION enqueue_mobile_push('interaction');

CREATE TRIGGER mobile_push_bot_message AFTER INSERT ON bot_messages FOR EACH ROW
  WHEN (NEW.kind = 'message' AND NEW.sender_id = NEW.bot_id::text AND NEW.recipient_id = 'user'
    AND NEW.created_at >= now() - interval '1 minute')
  EXECUTE FUNCTION enqueue_mobile_push('message');

CREATE TRIGGER mobile_push_bot_approval AFTER INSERT ON bot_approvals FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.created_at >= now() - interval '1 minute')
  EXECUTE FUNCTION enqueue_mobile_push('approval');
