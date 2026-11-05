-- Potwierdzenie tej konkretnej wymiany, niezależne od wcześniejszego stanu konta.
ALTER TABLE connector_oauth_states ADD COLUMN completed_at timestamptz;
