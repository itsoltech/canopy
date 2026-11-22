ALTER TABLE agent_memory_notes ADD COLUMN created_at timestamptz(3);

UPDATE agent_memory_notes SET created_at = updated_at WHERE revision = 1;

-- Production creates used UUIDv7. Its first 48 bits hold Unix milliseconds.
-- Check both version and variant before recovering an edited note's creation time.
UPDATE agent_memory_notes
SET created_at = to_timestamp(('x' || left(id::text, 8) || substr(id::text, 10, 4))::bit(48)::bigint / 1000.0)
WHERE revision > 1 AND id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]';

-- Set the default after the backfill to keep unknown historical dates null.
-- Both insert defaults use the same database timestamp for a new note.
ALTER TABLE agent_memory_notes
  ALTER COLUMN created_at SET DEFAULT statement_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT statement_timestamp();
