ALTER TABLE threads
  ADD COLUMN snoozed boolean NOT NULL DEFAULT false,
  ADD COLUMN snoozed_until timestamptz(3),
  ADD CONSTRAINT threads_snooze_deadline CHECK (snoozed OR snoozed_until IS NULL);

CREATE INDEX threads_snooze_due ON threads (owner_user_id, snoozed_until, id)
  WHERE snoozed_until IS NOT NULL AND deleted_at IS NULL AND moved_to IS NULL;
