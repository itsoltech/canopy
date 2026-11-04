-- Old pairings trusted a proxy rather than this computer's certificate. Require explicit re-pairing.
ALTER TABLE mobile_devices ADD COLUMN pairing_version integer NOT NULL DEFAULT 1;
UPDATE mobile_devices SET revoked_at = coalesce(revoked_at, now());
UPDATE mobile_pairings SET revoked_at = coalesce(revoked_at, now()) WHERE used_at IS NULL;
