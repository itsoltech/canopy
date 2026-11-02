ALTER TABLE schedules ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE schedules ADD COLUMN last_edited_by_user_id uuid REFERENCES users (id);
ALTER TABLE schedules ADD COLUMN last_edited_at timestamptz;
-- Identity of an occurrence survives rescheduling and lease invalidation, until it commits.
ALTER TABLE schedules ADD COLUMN occurrence_at timestamptz;
UPDATE schedules SET occurrence_at = next_run_at WHERE lease_owner IS NOT NULL;

ALTER TABLE schedules DROP CONSTRAINT schedules_last_turn_id_thread_id_fkey;
ALTER TABLE schedules DROP CONSTRAINT schedules_target;
ALTER TABLE schedules ADD CONSTRAINT schedules_target CHECK (
  (target = 'thread' AND thread_id IS NOT NULL AND new_thread IS NULL)
  OR (target = 'new_thread' AND thread_id IS NULL AND new_thread IS NOT NULL
      AND (created_by_user_id IS NOT NULL OR last_edited_by_user_id IS NOT NULL))
);
ALTER TABLE schedules DROP CONSTRAINT schedules_agent_bounded;
ALTER TABLE schedules ADD CONSTRAINT schedules_agent_bounded CHECK (
  created_by_call_id IS NULL OR last_edited_by_user_id IS NOT NULL
  OR (hops > 0 AND (kind = 'once' OR until IS NOT NULL OR max_runs IS NOT NULL))
);
CREATE TRIGGER schedules_update_require_visible BEFORE UPDATE OF thread_id ON schedules FOR EACH ROW
  WHEN (NEW.thread_id IS NOT NULL) EXECUTE FUNCTION thread_require_visible();

-- All configuration, status and run changes invalidate stale editors/claims, including archive/bus writes.
-- Lease renewals and the occurrence identity alone do not conflict with an open editor.
CREATE FUNCTION schedule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['version', 'lease_owner', 'lease_until', 'occurrence_at', 'updated_at'])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['version', 'lease_owner', 'lease_until', 'occurrence_at', 'updated_at']) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER schedules_revision BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION schedule_revision();
