-- A per-message or creation-time mode predates any explicit update of the thread default.
ALTER TABLE threads ADD COLUMN permission_mode_selected boolean NOT NULL DEFAULT false;
