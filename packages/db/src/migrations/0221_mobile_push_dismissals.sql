-- A delivered push waits for a silent dismissal once its result is read or its request is settled.
-- dismiss_at is due time (also the lease), dismissed_at closes the row for dismissal.
ALTER TABLE mobile_push_outbox
  ADD COLUMN dismiss_at timestamptz,
  ADD COLUMN dismissed_at timestamptz,
  ADD COLUMN dismiss_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE mobile_push_subscriptions ADD COLUMN last_dismissal_at timestamptz;

CREATE INDEX mobile_push_dismiss_due ON mobile_push_outbox (owner_user_id, dismiss_at) WHERE dismiss_at IS NOT NULL;
CREATE INDEX mobile_push_open_destination ON mobile_push_outbox (destination_id) WHERE dismissed_at IS NULL;
CREATE INDEX mobile_push_dismissed ON mobile_push_outbox (device_id, dismissed_at) WHERE dismissed_at IS NOT NULL;

-- Runs in the transaction that reads or settles. The sender re-checks every marked row before it goes out.
CREATE FUNCTION mark_mobile_push_dismissal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_type text := TG_ARGV[0];
BEGIN
  IF event_type = 'turn' THEN
    UPDATE mobile_push_outbox SET dismiss_at = clock_timestamp()
      WHERE destination_id = NEW.thread_id AND owner_user_id = NEW.user_id AND event_kind = 'turn'
        AND attempts > 0 AND dismiss_at IS NULL AND dismissed_at IS NULL;
  ELSIF event_type = 'message' THEN
    UPDATE mobile_push_outbox SET dismiss_at = clock_timestamp()
      WHERE destination_id = NEW.id AND owner_user_id = NEW.owner_user_id AND event_kind = 'message'
        AND attempts > 0 AND dismiss_at IS NULL AND dismissed_at IS NULL;
  -- Each branch names only its own table's columns: PL/pgSQL resolves NEW fields per statement.
  ELSIF event_type = 'interaction' THEN
    UPDATE mobile_push_outbox SET dismiss_at = clock_timestamp()
      WHERE destination_id = NEW.thread_id AND event_kind = 'interaction' AND event_id = NEW.id
        AND attempts > 0 AND dismiss_at IS NULL AND dismissed_at IS NULL;
  ELSE
    UPDATE mobile_push_outbox SET dismiss_at = clock_timestamp()
      WHERE destination_id = NEW.bot_id AND event_kind = 'approval' AND event_id = NEW.id
        AND attempts > 0 AND dismiss_at IS NULL AND dismissed_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER mobile_push_dismiss_turn AFTER INSERT OR UPDATE OF seen_seq, seen_at, marked_unread ON thread_reads
  FOR EACH ROW WHEN (NOT NEW.marked_unread)
  EXECUTE FUNCTION mark_mobile_push_dismissal('turn');

CREATE TRIGGER mobile_push_dismiss_interaction AFTER UPDATE OF status ON interaction_requests FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status <> 'pending')
  EXECUTE FUNCTION mark_mobile_push_dismissal('interaction');

CREATE TRIGGER mobile_push_dismiss_message AFTER UPDATE OF last_read_seq ON bots FOR EACH ROW
  WHEN (NEW.last_read_seq > OLD.last_read_seq)
  EXECUTE FUNCTION mark_mobile_push_dismissal('message');

CREATE TRIGGER mobile_push_dismiss_approval AFTER UPDATE OF status ON bot_approvals FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status <> 'pending')
  EXECUTE FUNCTION mark_mobile_push_dismissal('approval');
