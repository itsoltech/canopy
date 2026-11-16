-- Hop limits are runtime policy. Persist the chain beyond the wake limit so suppressed
-- notifications retain their provenance. Keep each lower bound and all other invariants.

ALTER TABLE turns
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT turns_hops_check,
  ADD CONSTRAINT turns_hops_check CHECK (hops >= 0);

ALTER TABLE turn_steers
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT turn_steers_hops_check,
  ADD CONSTRAINT turn_steers_hops_check CHECK (hops >= 0);

ALTER TABLE agent_bus_calls
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT agent_bus_calls_hops_check,
  ADD CONSTRAINT agent_bus_calls_hops_check CHECK (hops >= 1);

ALTER TABLE schedules
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT schedules_hops_check,
  ADD CONSTRAINT schedules_hops_check CHECK (hops >= 0);

ALTER TABLE bot_turns
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT bot_turns_hops_check,
  ADD CONSTRAINT bot_turns_hops_check CHECK (hops >= 0);

ALTER TABLE bot_thread_watches
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT bot_thread_watches_hops_check,
  ADD CONSTRAINT bot_thread_watches_hops_check CHECK (hops >= 1);

ALTER TABLE bot_wakeups
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT bot_wakeups_hops_check,
  ADD CONSTRAINT bot_wakeups_hops_check CHECK (hops >= 1);

ALTER TABLE bot_routines
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT bot_routines_hops_check,
  ADD CONSTRAINT bot_routines_hops_check CHECK (hops >= 1);

ALTER TABLE computer_agent_calls
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT computer_agent_calls_hops_check,
  ADD CONSTRAINT computer_agent_calls_hops_check CHECK (hops >= 0);

ALTER TABLE background_task_notes
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT background_task_notes_hops_check,
  ADD CONSTRAINT background_task_notes_hops_check CHECK (hops >= 1);

ALTER TABLE pr_check_watches
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT pr_check_watches_hops_check,
  ADD CONSTRAINT pr_check_watches_hops_check CHECK (hops >= 1);

ALTER TABLE pr_check_notes
  ALTER COLUMN hops TYPE integer,
  DROP CONSTRAINT pr_check_notes_hops_check,
  ADD CONSTRAINT pr_check_notes_hops_check CHECK (hops >= 1);
