ALTER TABLE threads ADD COLUMN auto_archive_on_merge boolean;
ALTER TABLE threads DROP CONSTRAINT threads_archived_by_check;
ALTER TABLE threads ADD CONSTRAINT threads_archived_by_check
  CHECK (archived_by IN ('user', 'agent', 'cascade', 'merge'));
