CREATE TABLE mobile_push_relay_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  origin text NOT NULL,
  encrypted_bearer bytea NOT NULL,
  key_id text NOT NULL,
  ca_pem text
);
