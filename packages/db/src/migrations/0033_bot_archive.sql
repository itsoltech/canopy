-- Archiwum zachowuje rozmowę i konfigurację. Pobudki czekają na przywrócenie.
ALTER TABLE bots ADD COLUMN archived_at timestamptz;
CREATE INDEX bots_active_owner ON bots(owner_user_id) WHERE deleted_at IS NULL AND archived_at IS NULL;
