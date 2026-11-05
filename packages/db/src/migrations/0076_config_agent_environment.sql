-- The agent environment library is shared configuration (docs/linked-computers.md). Linked computers name a
-- version by the SHA-256 of its content's JSON text, fetch it over the link and check it before storing it.
ALTER TABLE instruction_documents ADD COLUMN updated_at timestamptz;
UPDATE instruction_documents d SET updated_at=COALESCE((SELECT max(v.created_at) FROM instruction_document_versions v
  WHERE v.document_id=d.id AND v.owner_user_id=d.owner_user_id),d.created_at);
ALTER TABLE instruction_documents ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE agent_skills ADD COLUMN updated_at timestamptz;
UPDATE agent_skills s SET updated_at=COALESCE((SELECT max(v.created_at) FROM agent_skill_versions v
  WHERE v.skill_id=s.id AND v.owner_user_id=s.owner_user_id),s.created_at);
ALTER TABLE agent_skills ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE agent_marketplaces ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE agent_marketplaces SET updated_at=created_at;
ALTER TABLE agent_plugins ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE agent_plugins SET updated_at=created_at;

CREATE FUNCTION config_content_hash(content jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT encode(sha256(convert_to(content::text,'UTF8')),'hex') $$;

ALTER TABLE agent_skill_versions ADD COLUMN content_hash text;
UPDATE agent_skill_versions SET content_hash=config_content_hash(artifact);
ALTER TABLE agent_skill_versions ALTER COLUMN content_hash SET NOT NULL;
CREATE INDEX agent_skill_versions_hash ON agent_skill_versions(owner_user_id, content_hash);

ALTER TABLE agent_plugin_versions ADD COLUMN content_hash text;
UPDATE agent_plugin_versions SET content_hash=config_content_hash(plugin->'assignment'->'artifact');
ALTER TABLE agent_plugin_versions ALTER COLUMN content_hash SET NOT NULL;
CREATE INDEX agent_plugin_versions_hash ON agent_plugin_versions(owner_user_id, content_hash);

CREATE FUNCTION agent_skill_version_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := config_content_hash(NEW.artifact);
  RETURN NEW;
END $$;
CREATE FUNCTION agent_plugin_version_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := config_content_hash(NEW.plugin->'assignment'->'artifact');
  RETURN NEW;
END $$;
CREATE TRIGGER agent_skill_versions_hash BEFORE INSERT OR UPDATE ON agent_skill_versions
  FOR EACH ROW EXECUTE FUNCTION agent_skill_version_hash();
CREATE TRIGGER agent_plugin_versions_hash BEFORE INSERT OR UPDATE ON agent_plugin_versions
  FOR EACH ROW EXECUTE FUNCTION agent_plugin_version_hash();

-- Frozen marketplace catalogs stay for Restore and for linked computers, also after the catalog changes.
CREATE TABLE agent_marketplace_catalogs (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  plugins jsonb NOT NULL CHECK (jsonb_typeof(plugins) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, content_hash)
);
INSERT INTO agent_marketplace_catalogs(owner_user_id,content_hash,plugins)
  SELECT owner_user_id,config_content_hash(COALESCE(marketplace->'plugins','[]')),COALESCE(marketplace->'plugins','[]')
  FROM agent_marketplaces ON CONFLICT DO NOTHING;

CREATE FUNCTION agent_marketplace_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_marketplace_catalogs(owner_user_id,content_hash,plugins)
    VALUES(NEW.owner_user_id,config_content_hash(COALESCE(NEW.marketplace->'plugins','[]')),
      COALESCE(NEW.marketplace->'plugins','[]')) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_marketplaces_catalog AFTER INSERT OR UPDATE ON agent_marketplaces
  FOR EACH ROW EXECUTE FUNCTION agent_marketplace_catalog();
