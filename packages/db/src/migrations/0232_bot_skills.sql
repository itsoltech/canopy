-- Each bot belongs to a single owner. Keep only the name and last revision after deletion
-- so a stale edit cannot overwrite a new skill created under the same name.
CREATE TABLE bot_skills (
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name text COLLATE "C" NOT NULL CHECK (length(name) <= 64 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text CHECK (length(description) BETWEEN 1 AND 256),
  instructions text CHECK (length(instructions) BETWEEN 1 AND 16000),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (bot_id, name),
  CHECK ((description IS NULL) = (instructions IS NULL))
);
