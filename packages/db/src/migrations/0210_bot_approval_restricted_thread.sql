-- A private bot turn needs a destination-specific owner decision to write across audiences.
ALTER TABLE bot_approvals ADD COLUMN restricted_thread_id uuid;
