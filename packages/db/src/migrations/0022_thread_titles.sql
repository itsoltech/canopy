ALTER TABLE threads ADD COLUMN title_source text NOT NULL DEFAULT 'user'
  CHECK (title_source IN ('provisional', 'generated', 'user'));
-- Old titles have no provenance. Preserve them conservatively; only known placeholders are provisional.
UPDATE threads SET title_source = 'provisional' WHERE title IN ('', 'New thread');
ALTER TABLE threads ADD COLUMN title_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN title_requested boolean NOT NULL DEFAULT false;
ALTER TABLE threads ADD COLUMN title_context text NOT NULL DEFAULT '';
