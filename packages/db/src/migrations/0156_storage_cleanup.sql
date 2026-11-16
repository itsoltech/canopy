-- Opaque draft payloads must be indexed before abandoned uploads can be collected.
-- NULL is deliberately conservative, including writes by a gateway from before this migration.
ALTER TABLE bot_composer_drafts ADD COLUMN attachment_ids uuid[];
ALTER TABLE bot_composer_drafts ADD COLUMN attachment_index_retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX bot_composer_drafts_storage_backfill ON bot_composer_drafts(owner_user_id,attachment_index_retry_at,bot_id)
  WHERE attachment_ids IS NULL;
CREATE FUNCTION bot_draft_storage_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload THEN NEW.attachment_ids := NULL; NEW.attachment_index_retry_at := now(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_draft_storage_changed BEFORE UPDATE OF payload ON bot_composer_drafts
  FOR EACH ROW EXECUTE FUNCTION bot_draft_storage_changed();
CREATE INDEX blobs_storage_cleanup ON blobs(created_at,sha256) WHERE NOT retention_exempt;
