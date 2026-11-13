ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'video', 'file'));
ALTER TABLE attachments ADD COLUMN duration_ms bigint CHECK (duration_ms > 0 AND duration_ms <= 4294967295);
