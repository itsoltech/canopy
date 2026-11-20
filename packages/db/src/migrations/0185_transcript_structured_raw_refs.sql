-- Keep the existing two-path reference format. The optional json flag means the
-- mapped string encodes an entire provider object or array.
CREATE FUNCTION thread_event_raw_ref_value(p_payload jsonb, p_ref jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  payload_path text[] := ARRAY(SELECT jsonb_array_elements_text(p_ref->'payload'));
  replacement jsonb := p_payload #> payload_path;
BEGIN
  IF jsonb_typeof(replacement) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  IF p_ref->'json' = 'true'::jsonb THEN
    BEGIN
      replacement := (replacement #>> '{}')::jsonb;
    EXCEPTION WHEN data_exception THEN
      RETURN NULL;
    END;
    IF jsonb_typeof(replacement) NOT IN ('array','object') THEN RETURN NULL; END IF;
  END IF;
  RETURN replacement;
END $$;

CREATE OR REPLACE FUNCTION thread_event_raw(p_raw jsonb, p_payload jsonb, p_refs jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := p_raw;
  ref jsonb;
  raw_path text[];
  replacement jsonb;
BEGIN
  IF p_raw IS NULL OR p_refs IS NULL THEN RETURN p_raw; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    raw_path := ARRAY(SELECT jsonb_array_elements_text(ref->'raw'));
    replacement := thread_event_raw_ref_value(p_payload, ref);
    IF replacement IS NULL THEN RAISE EXCEPTION 'invalid transcript raw payload reference'; END IF;
    IF result #> raw_path IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'invalid transcript raw placeholder';
    END IF;
    IF cardinality(raw_path) = 0 THEN result := replacement;
    ELSE result := jsonb_set(result, raw_path, replacement, false);
    END IF;
  END LOOP;
  RETURN result;
END $$;

-- Work from the provider JSONB, not JS-parsed numbers. Compare the JSONB text
-- because JSONB equality alone treats numerics with different scales as equal.
CREATE FUNCTION thread_event_apply_raw_refs(p_raw jsonb, p_payload jsonb, p_candidates jsonb)
RETURNS TABLE (raw jsonb, refs jsonb) LANGUAGE plpgsql IMMUTABLE ROWS 1 AS $$
DECLARE
  ref jsonb;
  raw_path text[];
  original jsonb;
  replacement jsonb;
BEGIN
  raw := p_raw;
  IF p_raw IS NOT NULL AND p_candidates IS NOT NULL THEN
    FOR ref IN SELECT value FROM jsonb_array_elements(p_candidates) LOOP
      raw_path := ARRAY(SELECT jsonb_array_elements_text(ref->'raw'));
      original := raw #> raw_path;
      replacement := thread_event_raw_ref_value(p_payload, ref);
      IF replacement IS NULL THEN CONTINUE; END IF;
      IF ref->'json' = 'true'::jsonb THEN
        IF (original::text COLLATE "C") IS DISTINCT FROM (replacement::text COLLATE "C") THEN CONTINUE; END IF;
      ELSIF original IS DISTINCT FROM replacement THEN
        CONTINUE;
      END IF;
      IF cardinality(raw_path) = 0 THEN raw := 'null'::jsonb;
      ELSE raw := jsonb_set(raw, raw_path, 'null'::jsonb, false);
      END IF;
      refs := coalesce(refs, '[]'::jsonb) || ref;
    END LOOP;
  END IF;
  RETURN NEXT;
END $$;
