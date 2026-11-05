-- Per-field account configuration. Values remain in the domain tables.
ALTER TABLE computer_peers ADD COLUMN share_config boolean NOT NULL DEFAULT true;
ALTER TABLE computer_peers ADD COLUMN peer_share_config boolean NOT NULL DEFAULT true;
ALTER TABLE computer_peers ADD COLUMN share_config_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE computer_peers ADD COLUMN peer_share_config_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE computer_pairings ADD COLUMN share_config boolean NOT NULL DEFAULT true;

CREATE TABLE config_clock (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  hlc text NOT NULL DEFAULT ''
);
CREATE TABLE config_items (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  global_id text NOT NULL,
  local_id text NOT NULL DEFAULT '',
  home_node_id text NOT NULL DEFAULT '',
  identity text NOT NULL DEFAULT '',
  fields jsonb NOT NULL DEFAULT '{}',
  deleted jsonb NOT NULL DEFAULT '{"value":false,"hlc":"","prev":""}',
  revision bigint NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  unsupported text NOT NULL DEFAULT '',
  PRIMARY KEY (owner_user_id, kind, global_id)
);
CREATE INDEX config_items_revision ON config_items(owner_user_id, revision);
CREATE TABLE config_aliases (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  alias_id text NOT NULL,
  global_id text NOT NULL,
  PRIMARY KEY (owner_user_id, kind, alias_id)
);
CREATE TABLE config_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  global_id text NOT NULL,
  field text NOT NULL,
  value jsonb NOT NULL,
  hlc text NOT NULL,
  node_id text NOT NULL,
  notice_node_id text NOT NULL,
  secret boolean NOT NULL DEFAULT false,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','dismissed','restored')),
  reason text NOT NULL DEFAULT 'concurrent',
  UNIQUE (owner_user_id, kind, global_id, field, hlc)
);
CREATE TABLE config_peer_cursors (
  owner_user_id uuid NOT NULL,
  node_id text NOT NULL,
  cursor text NOT NULL DEFAULT '',
  PRIMARY KEY (owner_user_id, node_id),
  FOREIGN KEY (owner_user_id,node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE
);

-- Migration-only flattening: arrays are one user choice, object leaves independent choices.
CREATE FUNCTION config_migration_leaves(data jsonb, prefix text DEFAULT '')
RETURNS TABLE(field text, value jsonb) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry record; path text;
BEGIN
  FOR entry IN SELECT * FROM jsonb_each(data) LOOP
    path := CASE WHEN prefix='' THEN entry.key ELSE prefix||'.'||entry.key END;
    IF jsonb_typeof(entry.value)='object' THEN
      RETURN QUERY SELECT * FROM config_migration_leaves(entry.value,path);
    ELSE
      field := path; value := entry.value; RETURN NEXT;
    END IF;
  END LOOP;
END
$$;
CREATE FUNCTION config_migration_settings(data jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'appearance', (data->'appearance') - ARRAY['sidebarWidth','sidebarCollapsed','threadPanelCollapsed'],
    'threadDefaults', (data->'threadDefaults') - 'workspaceId',
    'timezone', data->'timezone', 'textGeneration', data->'textGeneration',
    'general', data->'general', 'composer', data->'composer',
    'sidebar', (data->'sidebar') - 'archived', 'cliUpdates', data->'cliUpdates'))
$$;

INSERT INTO config_clock(owner_user_id,revision)
SELECT s.user_id,1 FROM user_settings s JOIN computer_identity i ON i.owner_user_id=s.user_id;
INSERT INTO config_items(owner_user_id,kind,global_id,local_id,fields,revision)
SELECT s.user_id,'settings','account','account',COALESCE((SELECT jsonb_object_agg(l.field,
  jsonb_build_object('value',l.value,'hlc',floor(extract(epoch FROM s.updated_at)*1000)::bigint||'.0.'||i.node_id,'prev',''))
  FROM config_migration_leaves(config_migration_settings(s.settings)) l),'{}'::jsonb),1
FROM user_settings s JOIN computer_identity i ON i.owner_user_id=s.user_id;

-- Preserve both sides of pending 0050 questions. Pick the later value and keep the other as Restore.
DO $$
DECLARE c record; section text; local_time timestamptz; winner jsonb; loser jsonb; loser_node text; loser_time timestamptz;
BEGIN
  FOR c IN SELECT f.*,i.node_id AS self_node,p.name FROM computer_shared_conflicts f
    JOIN computer_identity i USING(owner_user_id)
    JOIN computer_peers p ON p.owner_user_id=f.owner_user_id AND p.node_id=f.node_id
    WHERE f.item_key LIKE 'settings:%'
  LOOP
    section := CASE split_part(c.item_key,':',2) WHEN 'thread_defaults' THEN 'threadDefaults'
      WHEN 'text_generation' THEN 'textGeneration' ELSE split_part(c.item_key,':',2) END;
    IF section NOT IN ('appearance','threadDefaults','timezone','textGeneration') THEN CONTINUE; END IF;
    SELECT changed_at INTO local_time FROM computer_shared_items WHERE owner_user_id=c.owner_user_id AND item_key=c.item_key;
    local_time := COALESCE(local_time,c.detected_at);
    IF c.remote_changed_at > local_time THEN
      winner := config_migration_settings(jsonb_build_object(section,
        CASE WHEN section='timezone' THEN c.remote_payload->'timezone' ELSE c.remote_payload END))->section;
      loser := c.local_payload; loser_node := c.self_node; loser_time := local_time;
      UPDATE user_settings SET settings=jsonb_set(settings,ARRAY[section],
        CASE WHEN section='timezone' THEN winner ELSE COALESCE(settings->section,'{}')||winner END),
        version=version+1 WHERE user_id=c.owner_user_id;
      UPDATE config_items SET fields=fields||COALESCE((SELECT jsonb_object_agg(l.field,
        jsonb_build_object('value',l.value,'hlc',floor(extract(epoch FROM c.remote_changed_at)*1000)::bigint||'.0.'||c.node_id,'prev',''))
        FROM config_migration_leaves(config_migration_settings(jsonb_build_object(section,
          winner))) l),'{}')
        WHERE owner_user_id=c.owner_user_id AND kind='settings' AND global_id='account';
    ELSE
      loser := c.remote_payload; loser_node := c.node_id; loser_time := c.remote_changed_at;
    END IF;
    INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
      SELECT c.owner_user_id,'settings','account',l.field,l.value,
        floor(extract(epoch FROM loser_time)*1000)::bigint||'.0.'||loser_node,loser_node,c.node_id,'merged'
      FROM config_migration_leaves(config_migration_settings(jsonb_build_object(section,
        CASE WHEN section='timezone' THEN loser->'timezone' ELSE loser END))) l ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
-- Pin references have a home. Existing qualified UI ids use only a node prefix.
CREATE FUNCTION config_migration_refs(fields jsonb, owner uuid, self_node text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE path text; pins jsonb;
BEGIN
  FOREACH path IN ARRAY ARRAY['sidebar.pinnedThreadIds','sidebar.pinnedBotIds'] LOOP
    IF fields ? path THEN
      SELECT COALESCE(jsonb_agg(split_part(ref,'~',1)||'@'||CASE WHEN position('~' IN ref)=0 THEN self_node
        ELSE COALESCE((SELECT node_id FROM computer_peers WHERE owner_user_id=owner
          AND left(node_id,16)=split_part(ref,'~',2)),split_part(ref,'~',2)) END),'[]'::jsonb)
        INTO pins FROM jsonb_array_elements_text(fields->path->'value') AS refs(ref);
      fields := jsonb_set(fields,ARRAY[path,'value'],pins);
    END IF;
  END LOOP;
  RETURN fields;
END $$;
UPDATE config_items c SET fields=config_migration_refs(c.fields,c.owner_user_id,i.node_id)
FROM computer_identity i WHERE c.owner_user_id=i.owner_user_id AND c.kind='settings';
DROP FUNCTION config_migration_refs(jsonb,uuid,text);
DELETE FROM computer_shared_conflicts WHERE item_key LIKE 'settings:%';
DELETE FROM computer_shared_acks WHERE item_key LIKE 'settings:%';
DELETE FROM computer_shared_items WHERE item_key LIKE 'settings:%';
DROP FUNCTION config_migration_settings(jsonb);
DROP FUNCTION config_migration_leaves(jsonb,text);
