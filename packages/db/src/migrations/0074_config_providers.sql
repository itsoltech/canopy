-- Shared provider instances, model lists and proxies. Records are seeded by the gateway at start,
-- where values, secrets and timestamps of every instance and proxy are read in one transaction.

-- The value of a secret field version, encrypted with this computer's key. Unknown kinds keep it too,
-- so a computer can pass a newer computer's secret on without understanding it.
CREATE TABLE config_secrets (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  global_id text NOT NULL,
  field text NOT NULL,
  hlc text NOT NULL,
  ciphertext bytea NOT NULL,
  -- The secrets row materialized from this version, when a domain table uses it.
  secret_id uuid,
  PRIMARY KEY (owner_user_id, kind, global_id, field, hlc)
);
-- A secret value lost concurrently or by deletion, for Restore. Never sent to another computer.
ALTER TABLE config_history ADD COLUMN ciphertext bytea;

-- Pending 0050 questions about instances and model lists: the later value wins, the other one stays as Restore.
-- Secret values of a question are not converted; the current key stays.
DO $$
DECLARE c record; harness text; id text; local_time timestamptz; remote_wins boolean; loser jsonb;
  loser_node text; loser_time timestamptz; allowed text[];
BEGIN
  FOR c IN SELECT f.*,i.node_id AS self_node FROM computer_shared_conflicts f
    JOIN computer_identity i USING(owner_user_id)
    WHERE f.item_key LIKE 'instance:%' OR f.item_key LIKE 'models:%'
  LOOP
    harness := split_part(c.item_key,':',2);
    id := split_part(c.item_key,':',3);
    SELECT changed_at INTO local_time FROM computer_shared_items WHERE owner_user_id=c.owner_user_id AND item_key=c.item_key;
    local_time := COALESCE(local_time,c.detected_at);
    remote_wins := c.remote_changed_at > local_time;
    allowed := CASE WHEN c.item_key LIKE 'models:%' THEN ARRAY['favorites','hidden','shown','custom']
      ELSE ARRAY['label','kind','baseUrl','accentColor'] END;
    IF remote_wins AND c.item_key LIKE 'models:%' THEN
      UPDATE provider_instances p SET
        favorites=ARRAY(SELECT jsonb_array_elements_text(COALESCE(c.remote_payload->'favorites','[]'))),
        hidden_models=ARRAY(SELECT jsonb_array_elements_text(COALESCE(c.remote_payload->'hidden','[]'))),
        shown_models=ARRAY(SELECT jsonb_array_elements_text(COALESCE(c.remote_payload->'shown','[]'))),
        custom_models=ARRAY(SELECT jsonb_array_elements_text(COALESCE(c.remote_payload->'custom','[]'))),
        updated_at=c.remote_changed_at
        WHERE p.harness=split_part(c.item_key,':',2) AND p.id=split_part(c.item_key,':',3);
    ELSIF remote_wins THEN
      UPDATE provider_instances p SET label=left(COALESCE(c.remote_payload->>'label',p.label),80),
        accent_color=CASE WHEN COALESCE(c.remote_payload->>'accentColor','') ~ '^(#[0-9a-f]{6})?$'
          THEN COALESCE(c.remote_payload->>'accentColor','') ELSE p.accent_color END,
        updated_at=c.remote_changed_at
        WHERE p.harness=split_part(c.item_key,':',2) AND p.id=split_part(c.item_key,':',3);
    END IF;
    IF remote_wins THEN
      loser := COALESCE(c.local_payload,'{}'); loser_node := c.self_node; loser_time := local_time;
    ELSE
      loser := c.remote_payload; loser_node := c.node_id; loser_time := c.remote_changed_at;
    END IF;
    INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
      SELECT c.owner_user_id,'instance',harness||':'||id,e.key,e.value,
        floor(extract(epoch FROM loser_time)*1000)::bigint||'.0.'||loser_node,loser_node,c.node_id,'merged'
      FROM jsonb_each(loser) e WHERE e.key=ANY(allowed) ON CONFLICT DO NOTHING;
    -- The remote connection is not applied here; it stays available to Restore.
    IF remote_wins AND c.item_key LIKE 'instance:%' THEN
      INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
        SELECT c.owner_user_id,'instance',harness||':'||id,e.key,e.value,
          floor(extract(epoch FROM c.remote_changed_at)*1000)::bigint||'.0.'||c.node_id,c.node_id,c.node_id,'merged'
        FROM jsonb_each(c.remote_payload) e WHERE e.key IN ('kind','baseUrl')
          AND e.value IS DISTINCT FROM COALESCE(c.local_payload->e.key,'null') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
DELETE FROM computer_shared_conflicts WHERE item_key LIKE 'instance:%' OR item_key LIKE 'models:%';
DELETE FROM computer_shared_acks WHERE item_key LIKE 'instance:%' OR item_key LIKE 'models:%';
DELETE FROM computer_shared_items WHERE item_key LIKE 'instance:%' OR item_key LIKE 'models:%';
