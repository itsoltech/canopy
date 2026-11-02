-- Soft delete is reversible. The batch id restores only children deleted with this operation.
ALTER TABLE threads ADD COLUMN deleted_at timestamptz;
ALTER TABLE threads ADD COLUMN deletion_batch_id uuid;
ALTER TABLE threads ADD COLUMN archived_by text CHECK (archived_by IN ('user', 'agent'));
ALTER TABLE threads ADD COLUMN archived_by_thread_id uuid REFERENCES threads(id);
ALTER TABLE thread_reads ADD COLUMN marked_unread boolean NOT NULL DEFAULT false;
CREATE INDEX threads_visible_owner ON threads(owner_user_id, created_at) WHERE deleted_at IS NULL;

-- Serialize new work and children with deletion. This also fences a schedule or a bus call that
-- resolved its target just before the user deleted it.
CREATE FUNCTION thread_require_visible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM threads WHERE id = NEW.thread_id AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'thread is archived or deleted' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER turns_require_visible BEFORE INSERT ON turns FOR EACH ROW EXECUTE FUNCTION thread_require_visible();
CREATE TRIGGER schedules_require_visible BEFORE INSERT ON schedules FOR EACH ROW EXECUTE FUNCTION thread_require_visible();

CREATE FUNCTION thread_require_visible_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_thread_id IS NOT NULL THEN
    PERFORM id FROM threads WHERE id = NEW.parent_thread_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'parent thread not found' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.fork_source_thread_id IS NOT NULL THEN
    PERFORM id FROM threads WHERE id = NEW.fork_source_thread_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source thread not found' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER threads_require_visible_parent BEFORE INSERT ON threads FOR EACH ROW EXECUTE FUNCTION thread_require_visible_parent();
