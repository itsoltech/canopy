-- Manual choices belong to the owner-scoped proxy row and disappear with it.
ALTER TABLE proxies ADD COLUMN account_plans jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(account_plans) = 'object');
