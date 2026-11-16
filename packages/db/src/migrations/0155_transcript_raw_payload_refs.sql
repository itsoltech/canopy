ALTER TABLE thread_events
  ADD COLUMN raw_payload_refs jsonb,
  ADD CONSTRAINT thread_events_raw_payload_refs_array
    CHECK (raw_payload_refs IS NULL OR jsonb_typeof(raw_payload_refs) = 'array') NOT VALID;

CREATE TABLE thread_transcript_compaction (
  thread_id   uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  scanned_seq bigint NOT NULL DEFAULT 0 CHECK (scanned_seq >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Reconstruct the complete provider JSON. Paths are JSON arrays of object keys / array indexes;
-- the canonical payload stays immutable, and refs only replace exact duplicate string leaves.
CREATE FUNCTION thread_event_raw(p_raw jsonb, p_payload jsonb, p_refs jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := p_raw;
  ref jsonb;
  raw_path text[];
  payload_path text[];
  replacement jsonb;
BEGIN
  IF p_raw IS NULL OR p_refs IS NULL THEN RETURN p_raw; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    raw_path := ARRAY(SELECT jsonb_array_elements_text(ref->'raw'));
    payload_path := ARRAY(SELECT jsonb_array_elements_text(ref->'payload'));
    replacement := p_payload #> payload_path;
    IF replacement IS NULL OR jsonb_typeof(replacement) <> 'string' THEN
      RAISE EXCEPTION 'invalid transcript raw payload reference';
    END IF;
    IF cardinality(raw_path) = 0 THEN result := replacement;
    ELSE
      IF result #> raw_path IS NULL OR jsonb_typeof(result #> raw_path) <> 'null' THEN
        RAISE EXCEPTION 'invalid transcript raw placeholder';
      END IF;
      result := jsonb_set(result, raw_path, replacement, false);
    END IF;
  END LOOP;
  RETURN result;
END $$;

-- Work from the original JSONB, never the JavaScript-parsed raw envelope: PostgreSQL
-- numeric values may contain more precision than a JavaScript number can represent.
CREATE FUNCTION thread_event_compact_raw(p_raw jsonb, p_refs jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := p_raw;
  ref jsonb;
  raw_path text[];
BEGIN
  IF p_raw IS NULL OR p_refs IS NULL THEN RETURN p_raw; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    raw_path := ARRAY(SELECT jsonb_array_elements_text(ref->'raw'));
    IF cardinality(raw_path) = 0 THEN result := 'null'::jsonb;
    ELSE
      IF result #> raw_path IS NULL OR jsonb_typeof(result #> raw_path) <> 'string' THEN
        RAISE EXCEPTION 'invalid transcript raw string reference';
      END IF;
      result := jsonb_set(result, raw_path, 'null'::jsonb, false);
    END IF;
  END LOOP;
  RETURN result;
END $$;
