-- Unknown historical sync times stay unknown until the next committed range.
ALTER TABLE thread_range_state ADD COLUMN last_synced_at timestamptz;
