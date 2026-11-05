-- Full access (PERMISSION_MODE_FULL_ACCESS, docs/protocol.md#tryb-uprawnień-tury): no sandbox, no prompts.
-- Turns and steers may carry it like the other modes (thread settings are jsonb and need no change).
ALTER TABLE turns DROP CONSTRAINT turns_permission_mode_check;
ALTER TABLE turns ADD CONSTRAINT turns_permission_mode_check
  CHECK (permission_mode IN ('', 'ASK', 'ACCEPT_EDITS', 'READ_ONLY', 'FULL_AUTO', 'FULL_ACCESS'));

ALTER TABLE turn_steers DROP CONSTRAINT turn_steers_permission_mode_check;
ALTER TABLE turn_steers ADD CONSTRAINT turn_steers_permission_mode_check
  CHECK (permission_mode IN ('', 'ASK', 'ACCEPT_EDITS', 'READ_ONLY', 'FULL_AUTO', 'FULL_ACCESS'));
