import type { Database } from "bun:sqlite";

// Version 0 was stored without an explicit user_version.
export const enrollmentSchema = `
  CREATE TABLE IF NOT EXISTS enrollment_secret (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS challenges (
    generation INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    proof_challenge TEXT NOT NULL,
    claim_hash TEXT NOT NULL,
    scope TEXT NOT NULL,
    binding TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verifying', 'rejected', 'complete')),
    proof_hash TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL UNIQUE,
    binding TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    generation INTEGER NOT NULL,
    bearer_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at);
  CREATE INDEX IF NOT EXISTS grants_expiry ON grants(expires_at);
  CREATE INDEX IF NOT EXISTS tickets_expiry ON tickets(expires_at);
  CREATE INDEX IF NOT EXISTS tickets_grant ON tickets(grant_id);
`;

export function migrateEnrollmentSchema(db: Database, legacyHardExpiry: number) {
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;

    if (version === 1) return;

    if (version !== 0) throw new Error("Unsupported push relay enrollment database version.");

    db.exec(enrollmentSchema);
    db.exec("ALTER TABLE grants ADD COLUMN hard_expires_at INTEGER NOT NULL DEFAULT 0");
    db.query("UPDATE grants SET hard_expires_at = ?1, expires_at = MIN(expires_at, ?1)").run(legacyHardExpiry);
    db.exec("PRAGMA user_version = 1");
  }).immediate();
}
