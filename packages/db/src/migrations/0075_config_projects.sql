-- Projects keep their local ids; the configuration record owns their shared identity.
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN config_deleted boolean NOT NULL DEFAULT false;
UPDATE projects p SET updated_at=COALESCE((SELECT changed_at FROM computer_shared_items s
  WHERE s.owner_user_id=p.owner_user_id AND s.item_key='project:'||p.id::text),p.created_at);

-- Pending project questions become ordinary per-field history. The later name wins.
DO $$
DECLARE c record; local_time timestamptz; loser jsonb; loser_node text; loser_time timestamptz;
BEGIN
  FOR c IN SELECT f.*,i.node_id AS self_node FROM computer_shared_conflicts f
    JOIN computer_identity i USING(owner_user_id) WHERE f.item_key LIKE 'project:%'
  LOOP
    SELECT p.updated_at INTO local_time FROM projects p WHERE p.id::text=split_part(c.item_key,':',2)
      AND p.owner_user_id=c.owner_user_id;
    IF local_time IS NULL THEN CONTINUE; END IF;
    IF c.remote_changed_at>local_time AND length(c.remote_payload->>'name') BETWEEN 1 AND 200
      AND c.remote_payload->>'name' !~ '[[:cntrl:]]' THEN
      UPDATE projects SET name=c.remote_payload->>'name',updated_at=c.remote_changed_at
        WHERE id::text=split_part(c.item_key,':',2) AND owner_user_id=c.owner_user_id AND kind<>'scratch';
      loser:=c.local_payload; loser_node:=c.self_node; loser_time:=local_time;
    ELSE
      loser:=c.remote_payload; loser_node:=c.node_id; loser_time:=c.remote_changed_at;
    END IF;
    IF loser ? 'name' THEN
      INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason)
        VALUES(c.owner_user_id,'project',split_part(c.item_key,':',2),'name',loser->'name',
          floor(extract(epoch FROM loser_time)*1000)::bigint||'.0.'||loser_node,loser_node,c.node_id,'merged')
        ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
DROP TABLE computer_shared_conflicts;
DROP TABLE computer_shared_acks;
DROP TABLE computer_shared_items;
