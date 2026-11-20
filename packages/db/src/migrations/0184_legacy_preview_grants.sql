-- Preserve the image access each thread already had before scoped uploads.
-- 0180 marked both surviving historical references and the blobs present at
-- cutover. Neither marker is set by subsequent events or uploads.
WITH old_links AS MATERIALIZED (
  SELECT p.thread_id, p.sha256
  FROM thread_blobs p JOIN threads t ON t.id = p.thread_id
  WHERE p.retained_history AND NOT p.verified AND t.purged_at IS NULL
), images AS MATERIALIZED (
  SELECT b.sha256
  FROM (SELECT DISTINCT sha256 FROM old_links) refs JOIN blobs b USING (sha256)
  WHERE b.legacy_retention_until IS NOT NULL
    AND CASE WHEN b.size_bytes BETWEEN 1 AND 8388608 AND b.size_bytes = octet_length(b.data) THEN
      CASE b.mime_type
        WHEN 'image/png' THEN substring(b.data FROM 1 FOR 8) = decode('89504e470d0a1a0a','hex')
        WHEN 'image/jpeg' THEN substring(b.data FROM 1 FOR 3) = decode('ffd8ff','hex')
        WHEN 'image/gif' THEN substring(b.data FROM 1 FOR 6) IN ('GIF87a'::bytea,'GIF89a'::bytea)
        WHEN 'image/webp' THEN substring(b.data FROM 1 FOR 4) = 'RIFF'::bytea
                            AND substring(b.data FROM 9 FOR 4) = 'WEBP'::bytea
        ELSE false
      END AND encode(sha256(b.data),'hex') = b.sha256
    ELSE false END
)
UPDATE thread_blobs p SET verified = true
FROM old_links l JOIN images i USING (sha256)
WHERE p.thread_id = l.thread_id AND p.sha256 = l.sha256 AND NOT p.verified;
