CREATE TABLE composer_draft_clock (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0
);

CREATE TABLE composer_drafts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
  target_key text NOT NULL CHECK (length(target_key) BETWEEN 1 AND 1000),
  thread_id uuid REFERENCES threads(id) ON DELETE CASCADE,
  target_thread_ref text NOT NULL DEFAULT '',
  payload bytea NOT NULL CHECK (octet_length(payload) <= 524288),
  revision bigint NOT NULL CHECK (revision > 0),
  mutation_id text NOT NULL,
  taken_by text,
  claim_id text,
  sending_request_id text,
  sent boolean NOT NULL DEFAULT false,
  send_result bytea,
  send_kind text,
  send_request bytea,
  delivery_request_id text,
  send_attempt_id uuid,
  send_active_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CHECK (length(mutation_id) BETWEEN 1 AND 200)
);
CREATE INDEX composer_drafts_owner_page ON composer_drafts(owner_user_id, updated_at DESC, id DESC);
CREATE INDEX composer_drafts_expiry ON composer_drafts(expires_at);
CREATE INDEX composer_drafts_thread ON composer_drafts(thread_id);

ALTER TABLE threads ADD COLUMN creation_request_id text;
CREATE UNIQUE INDEX threads_creation_request ON threads(owner_user_id, creation_request_id)
WHERE creation_request_id IS NOT NULL;

CREATE TABLE composer_draft_attachments (
  draft_id uuid NOT NULL REFERENCES composer_drafts(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  PRIMARY KEY (draft_id, attachment_id)
);

CREATE FUNCTION composer_draft_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Unsaved receipts and already hidden deliveries never invalidate draft lists.
  IF TG_OP='INSERT' AND (NEW.device_id='send-receipt' OR NEW.sent OR NEW.sending_request_id IS NOT NULL) THEN
    RETURN NULL;
  ELSIF TG_OP='DELETE' AND (OLD.device_id='send-receipt' OR OLD.sent OR OLD.sending_request_id IS NOT NULL) THEN
    RETURN NULL;
  ELSIF TG_OP='UPDATE'
    AND (OLD.device_id='send-receipt' OR OLD.sent OR OLD.sending_request_id IS NOT NULL)
    AND (NEW.device_id='send-receipt' OR NEW.sent OR NEW.sending_request_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=coalesce(NEW.owner_user_id, OLD.owner_user_id)) THEN
    RETURN NULL;
  END IF;
  INSERT INTO composer_draft_clock(owner_user_id, revision)
  VALUES (coalesce(NEW.owner_user_id, OLD.owner_user_id), 1)
  ON CONFLICT (owner_user_id) DO UPDATE SET revision=composer_draft_clock.revision+1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER composer_draft_change AFTER INSERT OR UPDATE OR DELETE ON composer_drafts
FOR EACH ROW EXECUTE FUNCTION composer_draft_changed();

CREATE FUNCTION delete_thread_composer_drafts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM composer_drafts WHERE thread_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_delete_composer_drafts AFTER UPDATE OF deleted_at ON threads
FOR EACH ROW EXECUTE FUNCTION delete_thread_composer_drafts();
