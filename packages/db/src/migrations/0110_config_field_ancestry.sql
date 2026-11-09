-- Conflict choices must preserve transitive observations when restored through another computer.
ALTER TABLE config_history ADD COLUMN ancestry jsonb NOT NULL DEFAULT '{"prev":"","seen":[]}';
