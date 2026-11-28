-- Read published manifests without walking tool output or ordinary messages.
CREATE INDEX thread_items_artifacts ON thread_items (thread_id, first_seq DESC)
  WHERE status='completed' AND (type IN ('image_gallery','published_video','visual')
    OR (type='agent_message' AND content->'agentMessage'->'images'->0 IS NOT NULL));

-- Unclassified item rows from an older receiver can still be read offline.
CREATE INDEX thread_range_artifacts ON thread_range_entities
  (owner_user_id, origin_node_id, thread_id, epoch, ordinal DESC)
  WHERE kind='item' AND state IN ('artifact','');
