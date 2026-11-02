-- Permission mode per turn (docs/ui-api.md, docs/protocol.md#tryb-uprawnień-tury).

-- The message's override while queued ('' = the thread's default), the mode sent to the worker once the turn
-- starts. Values as in threads.settings.permissionMode (PermissionMode enum names).
ALTER TABLE turns ADD COLUMN permission_mode text NOT NULL DEFAULT ''
  CHECK (permission_mode IN ('', 'ASK', 'ACCEPT_EDITS', 'READ_ONLY', 'FULL_AUTO'));

-- A steer joins the running turn with that turn's mode; its own override applies only when it falls back to the queue.
ALTER TABLE turn_steers ADD COLUMN permission_mode text NOT NULL DEFAULT ''
  CHECK (permission_mode IN ('', 'ASK', 'ACCEPT_EDITS', 'READ_ONLY', 'FULL_AUTO'));
