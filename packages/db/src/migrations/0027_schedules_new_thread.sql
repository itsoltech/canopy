ALTER TABLE schedules ALTER COLUMN thread_id DROP NOT NULL;
DROP TRIGGER schedules_require_visible ON schedules;
CREATE TRIGGER schedules_require_visible BEFORE INSERT ON schedules FOR EACH ROW
  WHEN (NEW.thread_id IS NOT NULL) EXECUTE FUNCTION thread_require_visible();
ALTER TABLE schedules ADD COLUMN project_id uuid REFERENCES projects (id);
UPDATE schedules s SET project_id = t.project_id FROM threads t WHERE t.id = s.thread_id;
ALTER TABLE schedules ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE schedules ADD COLUMN target text NOT NULL DEFAULT 'thread' CHECK (target IN ('thread', 'new_thread'));
ALTER TABLE schedules ADD COLUMN new_thread jsonb;
ALTER TABLE schedules ADD COLUMN concurrency text NOT NULL DEFAULT 'skip_if_running' CHECK (concurrency IN ('allow', 'skip_if_running'));
ALTER TABLE schedules ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN placement_cursor uuid REFERENCES project_workspaces (id);
ALTER TABLE schedules ADD CONSTRAINT schedules_target CHECK (
  (target = 'thread' AND thread_id IS NOT NULL AND new_thread IS NULL)
  OR (target = 'new_thread' AND thread_id IS NULL AND new_thread IS NOT NULL AND created_by_user_id IS NOT NULL)
);
-- New-thread schedules cannot use the old composite FK (their thread_id is null).
ALTER TABLE schedules ADD FOREIGN KEY (last_turn_id) REFERENCES turns (id);

CREATE TABLE schedule_runs (
  schedule_id uuid NOT NULL REFERENCES schedules (id),
  scheduled_for timestamptz NOT NULL,
  number integer NOT NULL DEFAULT 0 CHECK (number >= 0),
  thread_id uuid REFERENCES threads (id),
  turn_id uuid REFERENCES turns (id),
  worker_id uuid REFERENCES workers (id),
  workspace_id uuid REFERENCES project_workspaces (id),
  outcome text NOT NULL CHECK (outcome IN ('started', 'missed', 'running', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, scheduled_for),
  CHECK ((outcome = 'started') = (thread_id IS NOT NULL AND turn_id IS NOT NULL AND number > 0))
);
CREATE INDEX schedule_runs_thread ON schedule_runs (thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX schedule_runs_number ON schedule_runs (schedule_id, number) WHERE number > 0;
ALTER TABLE threads DROP CONSTRAINT threads_origin_check;
ALTER TABLE threads ADD CONSTRAINT threads_origin_check CHECK (origin IN ('user', 'agent', 'schedule'));
ALTER TABLE threads ADD COLUMN schedule_id uuid REFERENCES schedules (id);
ALTER TABLE threads ADD COLUMN schedule_name text NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN schedule_run integer CHECK (schedule_run > 0);
ALTER TABLE threads ADD CONSTRAINT threads_schedule_origin CHECK ((origin = 'schedule') = (schedule_id IS NOT NULL AND schedule_run IS NOT NULL));
CREATE UNIQUE INDEX threads_schedule_run ON threads (schedule_id, schedule_run) WHERE schedule_id IS NOT NULL;
