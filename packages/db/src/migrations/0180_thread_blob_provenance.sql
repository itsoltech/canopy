-- Only an authenticated upload or import can grant a preview. Older gateways
-- inserting hash-only links while upgrading also get the safe default.
ALTER TABLE thread_blobs ADD COLUMN verified boolean NOT NULL DEFAULT false;
ALTER TABLE thread_blobs ADD COLUMN claimed_by_event boolean NOT NULL DEFAULT false;
ALTER TABLE thread_blobs ADD COLUMN retained_history boolean NOT NULL DEFAULT false;
ALTER TABLE thread_blobs ADD COLUMN unverified_until timestamptz NOT NULL DEFAULT (now() + interval '30 days');
CREATE INDEX thread_blobs_unverified_expiry ON thread_blobs(unverified_until,thread_id,sha256)
  WHERE NOT verified AND NOT retained_history;

-- Preserve the bytes of pre-upgrade items even when their worker stays offline.
-- Only the historical snapshot at migration can pin unverified bytes. The
-- privilege to read them still requires separate evidence.
CREATE FUNCTION pg_temp.canopy_preview_hashes(item jsonb) RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $$
  SELECT digest FROM (VALUES
    (item #>> '{image,blob,sha256}'), (item #>> '{toolCall,outputBlob,sha256}'),
    (item #>> '{commandExecution,outputBlob,sha256}'), (item #>> '{backgroundTask,outputBlob,sha256}')
  ) AS refs(digest) WHERE digest IS NOT NULL
  UNION ALL SELECT r #>> '{}' FROM jsonb_path_query(item,'$.toolCall.images[*].sha256') AS r
  UNION ALL SELECT r #>> '{}' FROM jsonb_path_query(item,'$.fileChange.changes[*].diffBlob.sha256') AS r
$$;
WITH scopes AS MATERIALIZED (SELECT DISTINCT thread_id FROM thread_blobs),
items AS (
  SELECT i.thread_id,i.content AS item FROM scopes s JOIN thread_items i ON i.thread_id=s.thread_id
  WHERE i.type IN ('image','tool_call','command_execution','background_task','file_change')
  UNION ALL
  -- Keep earlier item versions visible to forks or rewinds as well.
  SELECT e.thread_id,coalesce(e.payload #> '{itemStarted,item}', e.payload #> '{itemCompleted,item}')
    FROM scopes s JOIN thread_events e ON e.thread_id=s.thread_id AND e.kind IN ('item_started','item_completed')
)
UPDATE thread_blobs p SET retained_history=true,claimed_by_event=true
FROM (SELECT DISTINCT i.thread_id,h.digest FROM items i
  CROSS JOIN LATERAL pg_temp.canopy_preview_hashes(i.item) AS h(digest)) AS refs
WHERE p.thread_id=refs.thread_id AND p.sha256=refs.digest;
DROP FUNCTION pg_temp.canopy_preview_hashes(jsonb);

-- Legacy moved transcripts have a binary protobuf snapshot rather than local
-- item rows. A stored reference also present in that snapshot protects the
-- bytes only; the old importer did not record verified upload receipts.
UPDATE thread_blobs p SET retained_history=true
FROM computer_moved_threads m WHERE m.thread_id=p.thread_id AND NOT p.retained_history
  AND position(convert_to(p.sha256,'UTF8') IN m.history)>0;

-- A locally bound attachment of this thread and owner is independent evidence.
-- Earlier federation imports bound files to a placeholder turn without checking
-- their digest before deduplication. Those rows cannot vouch for a preview.
UPDATE thread_blobs p SET verified=true
FROM threads t
WHERE t.id=p.thread_id AND t.purged_at IS NULL
  AND EXISTS (SELECT 1 FROM attachments a
    WHERE a.owner_user_id=t.owner_user_id AND a.thread_id=t.id
      AND (a.sha256=p.sha256 OR a.thumb_sha256=p.sha256)
      AND NOT EXISTS (SELECT 1 FROM computer_moved_threads m
        WHERE m.thread_id=t.id AND m.ordinal_turn_id=a.turn_id))
  AND EXISTS (SELECT 1 FROM blobs b WHERE b.sha256=p.sha256
    AND CASE WHEN octet_length(b.data)<=8388608 THEN encode(sha256(b.data),'hex')=p.sha256 ELSE false END);

-- A fast column default grants pre-upgrade bytes thirty days from migration.
-- New bytes enjoy the usual seven days from creation, including uploads by old gateways.
ALTER TABLE blobs ADD COLUMN legacy_retention_until timestamptz DEFAULT (now() + interval '30 days');
ALTER TABLE blobs ALTER COLUMN legacy_retention_until DROP DEFAULT;
CREATE INDEX blobs_retention_candidates ON blobs(created_at,sha256);

CREATE TABLE worker_preview_uploads (
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  journal_id text NOT NULL CHECK (length(journal_id) <= 128),
  thread_scope text NOT NULL CHECK (thread_scope = '' OR thread_scope ~ '^[0-9a-f-]{36}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL,
  data bytea NOT NULL,
  size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED CHECK (size_bytes BETWEEN 0 AND 8388608),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY(worker_id,journal_id,thread_scope,sha256)
);
CREATE INDEX worker_preview_uploads_expiry ON worker_preview_uploads(expires_at);
CREATE INDEX worker_preview_uploads_thread ON worker_preview_uploads(thread_scope) WHERE thread_scope<>'';
ALTER TABLE worker_event_quarantine ADD COLUMN payload_discarded boolean NOT NULL DEFAULT false;
CREATE INDEX worker_event_quarantine_expiry ON worker_event_quarantine(created_at,event_id);
