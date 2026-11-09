-- Extract field 1 (ui.Thread) without decoding or transferring the timeline.
-- Skip other wire fields too: protobuf does not require field-number order.
CREATE FUNCTION canopy_mirror_thread_metadata(data bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE pos integer := 0; tag bigint; size bigint; part integer; shift integer; wire integer;
BEGIN
  WHILE pos < octet_length(data) LOOP
    tag := 0; shift := 0;
    LOOP
      part := get_byte(data,pos); pos := pos+1;
      tag := tag | ((part & 127)::bigint << shift); shift := shift+7;
      EXIT WHEN part < 128;
      IF shift > 63 THEN RAISE EXCEPTION 'Invalid mirror protobuf tag'; END IF;
    END LOOP;
    wire := tag & 7;
    IF wire = 0 OR wire = 2 THEN
      size := 0; shift := 0;
      LOOP
        part := get_byte(data,pos); pos := pos+1;
        size := size | ((part & 127)::bigint << shift); shift := shift+7;
        EXIT WHEN part < 128;
        IF shift > 63 THEN RAISE EXCEPTION 'Invalid mirror protobuf value'; END IF;
      END LOOP;
      IF wire = 2 THEN
        IF size < 0 OR size > octet_length(data)-pos THEN RAISE EXCEPTION 'Invalid mirror protobuf length'; END IF;
        IF tag = 10 THEN RETURN substring(data FROM pos+1 FOR size::integer); END IF;
        pos := pos+size::integer;
      END IF;
    ELSIF wire = 1 THEN pos := pos+8;
    ELSIF wire = 5 THEN pos := pos+4;
    ELSE RAISE EXCEPTION 'Invalid mirror protobuf wire type';
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Missing mirror thread metadata';
END;
$$;

UPDATE computer_mirror_threads SET thread_metadata=canopy_mirror_thread_metadata(snapshot)
WHERE thread_metadata IS NULL;
ALTER TABLE computer_mirror_threads ALTER COLUMN thread_metadata SET NOT NULL;
DROP FUNCTION canopy_mirror_thread_metadata(bytea);
