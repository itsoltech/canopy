-- A row with no manual relay records an explicit choice to ignore deployment defaults.
ALTER TABLE mobile_push_relay_settings
  ALTER COLUMN origin DROP NOT NULL,
  ALTER COLUMN encrypted_bearer DROP NOT NULL,
  ALTER COLUMN key_id DROP NOT NULL,
  ADD CONSTRAINT mobile_push_relay_choice CHECK (
    (origin IS NOT NULL AND encrypted_bearer IS NOT NULL AND key_id IS NOT NULL)
    OR (origin IS NULL AND encrypted_bearer IS NULL AND key_id IS NULL AND ca_pem IS NULL)
  );
