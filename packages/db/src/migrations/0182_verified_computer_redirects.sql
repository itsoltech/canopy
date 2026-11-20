-- Old notices did not record who vouched for the move. Rebuild the locally
-- witnessed edges. Other homes can confirm their own departures on reconnect.
DELETE FROM computer_redirects;
ALTER TABLE computer_redirects DROP CONSTRAINT computer_redirects_pkey;
ALTER TABLE computer_redirects ADD PRIMARY KEY (owner_user_id, kind, item_id, from_node_id);
ALTER TABLE computer_redirects ADD COLUMN basis text NOT NULL CHECK (basis IN ('local_move','former_home'));

WITH evidence AS (
  SELECT m.owner_user_id, m.kind, f.id AS item_id, i.node_id AS former, m.peer_node_id AS home,
         coalesce(nullif(p.display_name,''), p.name, '') AS name, m.updated_at
  FROM computer_moves m JOIN computer_identity i USING (owner_user_id)
  LEFT JOIN computer_peers p ON p.owner_user_id=m.owner_user_id AND p.node_id=m.peer_node_id
  CROSS JOIN LATERAL (
    SELECT m.item_id AS id
    UNION
    SELECT value::uuid FROM jsonb_array_elements_text(m.frozen->'family')
    WHERE m.kind='thread'
  ) f
  WHERE m.role='source' AND m.state IN ('committed','done')
  UNION ALL
  SELECT m.owner_user_id, m.kind, f.id, m.peer_node_id, i.node_id, i.name, m.updated_at
  FROM computer_moves m JOIN computer_identity i USING (owner_user_id)
  CROSS JOIN LATERAL (
    SELECT m.item_id AS id
    UNION
    SELECT t.id FROM threads t JOIN computer_moved_threads h ON h.thread_id=t.id
    WHERE m.kind='thread' AND t.owner_user_id=m.owner_user_id AND t.root_thread_id=m.item_id
      AND h.from_node_id=m.peer_node_id
  ) f
  WHERE m.role='target' AND m.state='done'
)
INSERT INTO computer_redirects(owner_user_id,kind,item_id,from_node_id,home_node_id,home_name,moved_at,basis)
SELECT DISTINCT ON (owner_user_id,kind,item_id,former) owner_user_id,kind,item_id,former,home,name,updated_at,'local_move'
FROM evidence ORDER BY owner_user_id,kind,item_id,former,updated_at DESC;
