-- An announced route the partner no longer announces (docs/linked-computers.md, stage 6): kept as an old address,
-- tried last, and removed once a current route works or after 7 days.
ALTER TABLE computer_routes ADD COLUMN withdrawn_at timestamptz;
