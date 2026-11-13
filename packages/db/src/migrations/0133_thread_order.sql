ALTER TABLE threads ADD COLUMN sidebar_order_key text COLLATE "C";

-- Unmoved threads retain creation order, including exact timestamp ties.
CREATE FUNCTION thread_creation_order(at timestamptz, thread_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'a0V' || lpad(to_hex(281474976710655 - floor(extract(epoch FROM at) * 1000)::bigint), 12, '0')
    || translate(replace(thread_id::text, '-', ''), '0123456789abcdef', 'fedcba9876543210') || 'V'
$$;

-- Length-prefixed integers keep prepends/appends logarithmic; only a repeatedly split gap grows fractions.
CREATE FUNCTION thread_order_integer(key text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE size integer;
BEGIN
  size := CASE WHEN left(key, 1) COLLATE "C" >= 'a' THEN ascii(key) - ascii('a') + 2
    ELSE ascii('Z') - ascii(key) + 2 END;
  IF key !~ '^[A-Za-z][0-9A-Za-z]+$' OR length(key) < size
    OR (length(key) > size AND right(key, 1) = '0') THEN
    RAISE EXCEPTION 'invalid thread order key';
  END IF;
  RETURN left(key, size);
END
$$;

CREATE FUNCTION thread_order_step(key text, forward boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  head text := left(key, 1);
  digits text := substr(key, 2);
  i integer := length(digits);
  digit integer;
  size integer;
BEGIN
  WHILE i > 0 LOOP
    digit := strpos(alphabet, substr(digits, i, 1)) - 1;
    IF (forward AND digit < 61) OR (NOT forward AND digit > 0) THEN
      RETURN head || left(digits, i - 1) || substr(alphabet, digit + CASE WHEN forward THEN 2 ELSE 0 END, 1)
        || repeat(CASE WHEN forward THEN '0' ELSE 'z' END, length(digits) - i);
    END IF;
    i := i - 1;
  END LOOP;
  IF forward AND head = 'Z' THEN RETURN 'a0'; END IF;
  IF NOT forward AND head = 'a' THEN RETURN 'Zz'; END IF;
  IF (forward AND head = 'z') OR (NOT forward AND head = 'A') THEN RETURN NULL; END IF;
  head := chr(ascii(head) + CASE WHEN forward THEN 1 ELSE -1 END);
  size := CASE WHEN head COLLATE "C" >= 'a' THEN ascii(head) - ascii('a') + 1
    ELSE ascii('Z') - ascii(head) + 1 END;
  RETURN head || repeat(CASE WHEN forward THEN '0' ELSE 'z' END, size);
END
$$;

CREATE FUNCTION thread_order_fraction(lo text, hi text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  prefix text := '';
  i integer := 1;
  a integer;
  b integer;
BEGIN
  LOOP
    a := CASE WHEN i <= length(lo) THEN strpos(alphabet, substr(lo, i, 1)) - 1 ELSE 0 END;
    b := CASE WHEN hi IS NULL THEN 62 ELSE strpos(alphabet, substr(hi, i, 1)) - 1 END;
    IF b - a > 1 THEN RETURN prefix || substr(alphabet, (a + b) / 2 + 1, 1); END IF;
    prefix := prefix || substr(alphabet, a + 1, 1);
    IF a < b THEN hi := NULL; END IF;
    i := i + 1;
  END LOOP;
END
$$;

CREATE FUNCTION thread_order_between(lo text, hi text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ai text := CASE WHEN lo IS NULL THEN NULL ELSE thread_order_integer(lo) END;
  bi text := CASE WHEN hi IS NULL THEN NULL ELSE thread_order_integer(hi) END;
  step text;
BEGIN
  IF lo IS NOT NULL AND hi IS NOT NULL AND lo COLLATE "C" >= hi COLLATE "C" THEN
    RAISE EXCEPTION 'invalid thread order bounds';
  END IF;
  IF lo IS NULL THEN
    IF hi IS NULL THEN RETURN 'a0'; END IF;
    step := thread_order_step(bi, false);
    IF step IS NOT NULL THEN RETURN step; END IF;
    IF length(hi) = length(bi) THEN RAISE EXCEPTION 'thread order space exhausted'; END IF;
    RETURN bi || thread_order_fraction(NULL, substr(hi, length(bi) + 1));
  END IF;
  IF hi IS NULL THEN
    step := thread_order_step(ai, true);
    IF step IS NOT NULL THEN RETURN step; END IF;
    RETURN ai || thread_order_fraction(substr(lo, length(ai) + 1), NULL);
  END IF;
  IF ai = bi THEN
    RETURN ai || thread_order_fraction(substr(lo, length(ai) + 1), substr(hi, length(bi) + 1));
  END IF;
  step := thread_order_step(ai, true);
  IF step IS NOT NULL AND step COLLATE "C" < hi COLLATE "C" THEN RETURN step; END IF;
  RETURN ai || thread_order_fraction(substr(lo, length(ai) + 1), NULL);
END
$$;

ALTER TABLE threads ADD CONSTRAINT threads_sidebar_order_valid CHECK (
  sidebar_order_key IS NULL OR thread_order_integer(sidebar_order_key) IS NOT NULL
);
CREATE INDEX threads_sidebar_order ON threads
  (owner_user_id, (coalesce(sidebar_order_key, thread_creation_order(created_at, id))) COLLATE "C")
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE FUNCTION thread_initial_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE first_key text;
BEGIN
  -- Same owner lock as moves: concurrent creation cannot reuse the top position.
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_order:' || NEW.owner_user_id::text, 0));
  SELECT coalesce(sidebar_order_key, thread_creation_order(created_at, id)) INTO first_key
    FROM threads WHERE owner_user_id = NEW.owner_user_id AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY coalesce(sidebar_order_key, thread_creation_order(created_at, id)) COLLATE "C" LIMIT 1;
  NEW.sidebar_order_key := thread_order_between(NULL, first_key);
  RETURN NEW;
END
$$;
CREATE TRIGGER threads_00_initial_order BEFORE INSERT ON threads
  FOR EACH ROW EXECUTE FUNCTION thread_initial_order();

CREATE INDEX thread_items_latest_reply ON thread_items(thread_id, last_seq DESC)
  WHERE type = 'agent_message';
