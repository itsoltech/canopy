-- Odróżniamy zamknięcie z głównym wątkiem od wcześniejszej, niezależnej archiwizacji.
ALTER TABLE threads DROP CONSTRAINT threads_archived_by_check;
ALTER TABLE threads ADD CONSTRAINT threads_archived_by_check CHECK (archived_by IN ('user', 'agent', 'cascade'));
ALTER TABLE threads ADD CONSTRAINT threads_archive_cascade_parent CHECK
  (archived_by IS DISTINCT FROM 'cascade' OR (kind = 'side' AND archived_by_thread_id = parent_thread_id AND archived_at IS NOT NULL));
CREATE INDEX threads_archived_owner ON threads(owner_user_id, archived_at DESC, id DESC)
  WHERE deleted_at IS NULL AND archived_at IS NOT NULL;

-- Ten sam zamek rodzica co kaskada: nowy boczny wątek nie może ominąć archiwizacji.
CREATE OR REPLACE FUNCTION thread_require_visible_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_thread_id IS NOT NULL THEN
    PERFORM id FROM threads WHERE id = NEW.parent_thread_id AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'parent thread is archived or deleted' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.fork_source_thread_id IS NOT NULL THEN
    PERFORM id FROM threads WHERE id = NEW.fork_source_thread_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source thread not found' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
