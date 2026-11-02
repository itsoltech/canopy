-- Snapshot zatwierdzanej konfiguracji i pochodzenia. Rozmowa nowego bota pozostaje pusta.
ALTER TABLE bot_approvals ADD COLUMN proposed_bot jsonb;
ALTER TABLE bots ADD COLUMN created_by_bot_id uuid REFERENCES bots(id);
ALTER TABLE bots ADD COLUMN created_by_bot_name text NOT NULL DEFAULT '';
