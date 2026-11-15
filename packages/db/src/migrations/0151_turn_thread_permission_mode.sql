-- Keep the thread default at dispatch separate from the owner's per-turn override.
-- Empty snapshots preserve the existing ceiling for turns started before this migration.
ALTER TABLE turns ADD COLUMN thread_permission_mode text NOT NULL DEFAULT ''
  CHECK (thread_permission_mode IN ('', 'ASK', 'ACCEPT_EDITS', 'READ_ONLY', 'FULL_AUTO', 'FULL_ACCESS'));
