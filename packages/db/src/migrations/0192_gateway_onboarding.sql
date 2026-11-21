CREATE TABLE gateway_onboarding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  first_version text
);

-- The migrator records every migration in a batch in one transaction. Migration 1 belongs
-- to this transaction only when this run initializes Canopy on an empty database.
INSERT INTO gateway_onboarding (singleton)
SELECT true FROM schema_migrations WHERE migration_id = 1 AND created_at = transaction_timestamp();
