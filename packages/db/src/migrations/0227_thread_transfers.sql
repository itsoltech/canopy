-- Moving a thread to another worker of the same gateway (docs/thread-transfers.md). The gateway freezes the
-- thread family, the source worker exports its checkout and harness sessions, the target worker recreates them in a
-- new worktree, and one transaction moves the family's placement. Before that commit the move rolls back; after it,
-- it only goes forward (the source releases its package).

-- Frozen for a move: no turn, steer, goal, schedule change, side thread or agent call may start meanwhile.
ALTER TABLE threads ADD COLUMN transfer_pending_id uuid;

CREATE TABLE thread_transfers (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  id uuid PRIMARY KEY,
  -- The main thread; family lists it and its side threads, which share its folder.
  thread_id uuid NOT NULL REFERENCES threads(id),
  family uuid[] NOT NULL,
  source_worker_id uuid NOT NULL REFERENCES workers(id),
  target_worker_id uuid NOT NULL REFERENCES workers(id),
  source_workspace_id uuid NOT NULL REFERENCES project_workspaces(id),
  target_workspace_id uuid NOT NULL REFERENCES project_workspaces(id),
  source_cwd text NOT NULL,
  source_worktree_id uuid,
  -- The new worktree on the target, known once it is checked out.
  target_cwd text,
  target_worktree_id uuid REFERENCES worktrees(id),
  -- Every checkout attempt ({id, commandId, branch, head}), recorded before it runs: a rollback removes what each
  -- created, replaying an attempt whose answer was lost.
  worktree_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{threadId, provider, providerThreadId, sourceProfileId, targetProfileId}]
  sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Ignored local files the owner chose to take along (paths relative to the folder).
  local_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_head text NOT NULL DEFAULT '',
  branch text NOT NULL DEFAULT '',
  -- preparing → prepared → committed → done, or preparing/prepared → aborted.
  state text NOT NULL CHECK (state IN ('preparing', 'prepared', 'committed', 'done', 'aborted')),
  phase text NOT NULL DEFAULT '',
  bytes bigint NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  -- Schedules of the family paused by the freeze, with their status, restored afterwards.
  frozen_schedules jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- An aborted move whose leftovers (target staging, adopted sessions, worktrees, source package) are not gone yet.
  cleanup_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_worker_id <> target_worker_id)
);
-- Admission only: a committed move releasing its packages (a worker may be offline) does not block the next one.
CREATE UNIQUE INDEX thread_transfers_active ON thread_transfers(thread_id)
  WHERE state IN ('preparing', 'prepared');
CREATE INDEX thread_transfers_owner ON thread_transfers(owner_user_id, created_at DESC);

-- Every producer of work checks the freeze under the thread lock, as rewind admission does.
CREATE FUNCTION thread_transfer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF NEW.thread_id IS NULL THEN RETURN NEW; END IF;
  SELECT transfer_pending_id INTO pending FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER turns_transfer_admission BEFORE INSERT ON turns
  FOR EACH ROW EXECUTE FUNCTION thread_transfer_admission();
-- A withdrawn turn restored to the queue, or a queued turn dispatched, is new work too: refused while the thread is
-- frozen for a move to another worker or (moved_to) to a linked computer.
CREATE FUNCTION turn_requeue_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; moving text;
BEGIN
  SELECT transfer_pending_id, moved_to INTO pending, moving FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF pending IS NOT NULL OR moving IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is moving. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER turns_transfer_requeue BEFORE UPDATE OF status ON turns
  FOR EACH ROW WHEN (NEW.status IN ('queued', 'running') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION turn_requeue_admission();
-- The freeze pauses the family's schedules and restores them afterwards; the owner changes them after the move.
-- The freeze locks the schedule rows, so a change it has not seen yet is read again; no thread lock is needed.
-- A new schedule takes a share lock on its thread first, so it either waits for the freeze (and sees it) or the freeze
-- waits for it (and pauses it).
CREATE FUNCTION schedule_transfer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new schedule also waits for a linked computer's freeze, and is refused once it froze the thread.
    SELECT CASE WHEN moved_to IS NULL THEN transfer_pending_id ELSE NEW.thread_id END INTO pending
      FROM threads WHERE id=NEW.thread_id FOR SHARE;
  ELSE
    SELECT transfer_pending_id INTO pending FROM threads WHERE id=NEW.thread_id;
  END IF;
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedules_transfer_admission BEFORE INSERT OR UPDATE OF status ON schedules
  FOR EACH ROW EXECUTE FUNCTION schedule_transfer_admission();
CREATE TRIGGER steers_transfer_admission BEFORE INSERT ON turn_steers
  FOR EACH ROW EXECUTE FUNCTION thread_transfer_admission();
CREATE TRIGGER goals_transfer_admission BEFORE INSERT OR UPDATE OF status ON goals
  FOR EACH ROW EXECUTE FUNCTION thread_transfer_admission();

CREATE FUNCTION agent_call_transfer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF NEW.status='failed' THEN RETURN NEW; END IF;
  SELECT transfer_pending_id INTO pending FROM threads WHERE id=NEW.source_thread_id FOR UPDATE;
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_calls_transfer_admission BEFORE INSERT ON agent_bus_calls
  FOR EACH ROW EXECUTE FUNCTION agent_call_transfer_admission();

-- A side thread joins its family only while the family is not moving (to another worker, or to a linked computer:
-- moved_to). The parent's row lock orders it against either freeze, which then reads the family again.
CREATE FUNCTION side_thread_transfer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; moving text;
BEGIN
  SELECT transfer_pending_id, moved_to INTO pending, moving FROM threads WHERE id=NEW.parent_thread_id FOR SHARE;
  IF pending IS NOT NULL OR moving IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER side_threads_transfer_admission BEFORE INSERT ON threads
  FOR EACH ROW WHEN (NEW.parent_thread_id IS NOT NULL) EXECUTE FUNCTION side_thread_transfer_admission();

-- Placement stays immutable, except for the commit of a prepared transfer of this thread to exactly the target it
-- prepared (the transaction names the transfer in canopy.thread_transfer). Everything else as in 0213.
CREATE OR REPLACE FUNCTION threads_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transferred boolean := false;
BEGIN
  IF OLD.rewind_pending_id IS NOT NULL AND (NEW.archived_at,NEW.deleted_at,NEW.moved_to)
      IS DISTINCT FROM (OLD.archived_at,OLD.deleted_at,OLD.moved_to) THEN
    RAISE EXCEPTION 'Wait for the thread to finish rewinding.' USING ERRCODE='check_violation';
  END IF;
  IF OLD.transfer_pending_id IS NOT NULL AND (NEW.archived_at,NEW.deleted_at,NEW.moved_to,NEW.rewind_pending_id)
      IS DISTINCT FROM (OLD.archived_at,OLD.deleted_at,OLD.moved_to,OLD.rewind_pending_id) THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  IF OLD.transfer_pending_id IS NOT NULL
     AND OLD.transfer_pending_id::text = current_setting('canopy.thread_transfer', true)
     AND NEW.transfer_pending_id IS NULL
     AND (NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
          NEW.runtime, NEW.provider, NEW.fork_source_thread_id, NEW.fork_after_turn_id, NEW.provider_thread_id)
         IS NOT DISTINCT FROM
         (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
          OLD.runtime, OLD.provider, OLD.fork_source_thread_id, OLD.fork_after_turn_id, OLD.provider_thread_id)
     AND EXISTS (
       SELECT 1 FROM thread_transfers x
       WHERE x.id=OLD.transfer_pending_id AND x.owner_user_id=OLD.owner_user_id AND x.state='prepared'
         AND OLD.id = ANY(x.family) AND x.source_worker_id=OLD.worker_id
         AND x.target_worker_id=NEW.worker_id AND x.target_workspace_id=NEW.workspace_id
         AND x.target_cwd=NEW.cwd AND x.target_worktree_id IS NOT DISTINCT FROM NEW.worktree_id) THEN
    transferred := true;
  END IF;
  -- What the move checked stays as it was until it ends: the instance and the sandbox profile.
  IF OLD.transfer_pending_id IS NOT NULL AND NOT transferred
     AND (NEW.provider_profile_id, NEW.settings->'sandboxProfile')
         IS DISTINCT FROM (OLD.provider_profile_id, OLD.settings->'sandboxProfile') THEN
    RAISE EXCEPTION 'This thread is moving to another worker. Try again in a moment.' USING ERRCODE='check_violation';
  END IF;
  IF NOT transferred AND ((NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
      NEW.runtime, NEW.provider, NEW.worker_id, NEW.workspace_id, NEW.fork_source_thread_id, NEW.fork_after_turn_id)
     IS DISTINCT FROM
     (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
      OLD.runtime, OLD.provider, OLD.worker_id, OLD.workspace_id, OLD.fork_source_thread_id, OLD.fork_after_turn_id)
     OR (OLD.preparation_fingerprint IS NOT NULL AND NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id)) THEN
    RAISE EXCEPTION 'thread placement and lineage are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT transferred AND (NEW.cwd, NEW.worktree_id, NEW.preparation_fingerprint)
     IS DISTINCT FROM (OLD.cwd, OLD.worktree_id, OLD.preparation_fingerprint)
     AND NOT (
       OLD.preparation_fingerprint IS NOT NULL AND NEW.preparation_fingerprint IS NULL
       AND OLD.status = 'creating' AND OLD.archived_at IS NULL AND OLD.deleted_at IS NULL AND OLD.moved_to IS NULL
       AND OLD.provider_thread_id IS NULL AND OLD.rewind_pending_id IS NULL
       AND NEW.cwd IS NOT NULL AND NEW.worktree_id IS NOT NULL
       AND NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND NEW.moved_to IS NULL
       AND NEW.provider_thread_id IS NULL AND NEW.rewind_pending_id IS NULL
     )
     AND NOT (
       OLD.preparation_fingerprint IS NULL AND NEW.preparation_fingerprint IS NULL
       AND OLD.runtime='worker' AND OLD.cwd IS NOT NULL AND NEW.cwd IS NOT NULL
       AND OLD.archived_at IS NULL AND OLD.deleted_at IS NULL AND OLD.moved_to IS NULL AND OLD.rewind_pending_id IS NULL
       AND NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND NEW.moved_to IS NULL AND NEW.rewind_pending_id IS NULL
       AND nullif(OLD.settings->'sandboxProfile','null'::jsonb) IS NULL
       AND ((NEW.worktree_id IS NOT NULL AND NEW.worktree_id IS DISTINCT FROM OLD.worktree_id) OR
            (NEW.worktree_id IS NULL AND NEW.cwd = (SELECT root_path FROM project_workspaces WHERE id=NEW.workspace_id)))
       AND EXISTS (SELECT 1 FROM turns WHERE id=nullif(current_setting('canopy.switch_worktree_turn',true),'')::uuid
                     AND thread_id=OLD.id AND status='running' AND rewind_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'thread worktree placement is immutable outside finalization or an active turn switch' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id
     AND (NEW.provider_thread_id IS NULL OR EXISTS (
       SELECT 1 FROM turns WHERE thread_id=NEW.id AND started_at IS NOT NULL
         AND rewind_id IS NULL AND provider_session_id=OLD.provider_thread_id))
     AND NOT EXISTS (
       SELECT 1 FROM thread_rewinds r WHERE r.id=OLD.rewind_pending_id AND r.thread_id=OLD.id
         AND r.owner_user_id=OLD.owner_user_id
         AND ((r.status='completed' AND OLD.provider_thread_id=r.source_provider_thread_id
                AND NEW.provider_thread_id=r.replacement_provider_thread_id)
           OR (r.status='restored' AND OLD.provider_thread_id=r.replacement_provider_thread_id
                AND NEW.provider_thread_id=r.source_provider_thread_id))) THEN
    RAISE EXCEPTION 'provider session replacement requires a completed rewind' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Target of a linked-computer move that carries the thread's session and files (docs/thread-transfers.md): what the
-- authenticated partner staged here for one move. Every later step, cleanup and the PrepareMove check use this row,
-- never paths or worktree ids the partner names.
CREATE TABLE computer_move_files (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  move_id uuid PRIMARY KEY,
  peer_node_id text NOT NULL,
  -- The token this computer's worker knows the move by (chosen here, never by the partner).
  token uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES project_workspaces(id),
  worker_id uuid NOT NULL REFERENCES workers(id),
  -- Every checkout attempt this move made (recorded first, as in thread_transfers), and the worktree it got.
  worktree_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  worktree_id uuid,
  worktree_path text,
  -- The worker's adoption receipt: thread id → {provider, profileId, providerThreadId}.
  sessions jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- receiving → applied → staged (PrepareMove took it) → kept (the move committed) → done;
  -- or any state before kept → dropping → done.
  state text NOT NULL CHECK (state IN ('receiving', 'applied', 'staged', 'kept', 'dropping', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX computer_move_files_open ON computer_move_files(owner_user_id, updated_at) WHERE state <> 'done';

-- A provider session is adopted by one move at a time on this computer, from the apply until the move ends.
CREATE TABLE computer_move_file_sessions (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  move_id uuid NOT NULL REFERENCES computer_move_files(move_id) ON DELETE CASCADE,
  provider_thread_id text NOT NULL,
  PRIMARY KEY (owner_user_id, provider_thread_id)
);
