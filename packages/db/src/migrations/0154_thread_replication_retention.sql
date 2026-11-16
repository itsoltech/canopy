-- Bounded replay keeps a contiguous suffix. A cursor below the floor is rebuilt
-- through the existing epoch/snapshot path; it must never be advanced over a gap.
ALTER TABLE thread_replication_clock
  ADD COLUMN replay_floor_seq bigint NOT NULL DEFAULT 0 CHECK (replay_floor_seq >= 0 AND replay_floor_seq <= head_seq),
  ADD COLUMN retention_checked_at timestamptz NOT NULL DEFAULT 'epoch';
CREATE INDEX thread_replication_retention_scan ON thread_replication_clock(owner_user_id,retention_checked_at,thread_id);

-- Epoch replacement starts a new contiguous replay domain. The checkpoint and
-- retention floor belong to the old domain and must not survive the switch.
CREATE OR REPLACE FUNCTION thread_replication_checkpoint_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch<>OLD.epoch THEN
    NEW.checkpoint_seq=0;
    NEW.replay_floor_seq=0;
    DELETE FROM thread_replication_entity_content WHERE thread_id=NEW.thread_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE thread_replication_journal
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN content_sha256 text,
  ADD COLUMN content_invalid boolean NOT NULL DEFAULT false,
  ADD COLUMN content_indexed boolean NOT NULL DEFAULT false;
ALTER TABLE thread_replication_seed_entities
  ADD COLUMN content_sha256 text,
  ADD COLUMN content_invalid boolean NOT NULL DEFAULT false,
  ADD COLUMN content_indexed boolean NOT NULL DEFAULT false;
CREATE INDEX thread_replication_journal_invalid ON thread_replication_journal(thread_id)
  WHERE content_invalid;
CREATE INDEX thread_replication_seed_invalid ON thread_replication_seed_entities(thread_id)
  WHERE content_invalid;
CREATE INDEX thread_replication_journal_content ON thread_replication_journal(thread_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;
CREATE INDEX thread_replication_journal_unindexed ON thread_replication_journal(thread_id, seq)
  WHERE payload IS NOT NULL AND NOT content_indexed;
CREATE INDEX thread_replication_seed_content ON thread_replication_seed_entities(thread_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;
CREATE INDEX thread_replication_seed_unindexed ON thread_replication_seed_entities(thread_id, entity_id)
  WHERE payload IS NOT NULL AND NOT content_indexed;
CREATE INDEX thread_replication_journal_retention
  ON thread_replication_journal(thread_id, epoch, seq, created_at);

-- A generation is a bounded snapshot or an in-flight range subscription. The
-- lease protects the cursor and all content references handed to that client.
-- It is deliberately separate from the receiver's computer_mirror_generations:
-- the source cannot infer receiver state from that table.
CREATE TABLE thread_replication_snapshot_generations (
  thread_id uuid NOT NULL REFERENCES thread_replication_clock(thread_id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  epoch uuid NOT NULL,
  head_seq bigint NOT NULL CHECK (head_seq >= 0),
  applied_seq bigint NOT NULL DEFAULT 0 CHECK (applied_seq >= 0 AND applied_seq <= head_seq),
  kind text NOT NULL CHECK (kind IN ('range', 'snapshot')),
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (thread_id, generation)
);
CREATE INDEX thread_replication_snapshot_live
  ON thread_replication_snapshot_generations(thread_id, epoch, lease_until, applied_seq);

ALTER TABLE thread_replication_content
  ADD COLUMN last_referenced_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE thread_replication_content_leases (
  thread_id uuid NOT NULL,
  sha256 text NOT NULL,
  generation uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (thread_id, sha256, generation),
  FOREIGN KEY (thread_id, generation)
    REFERENCES thread_replication_snapshot_generations(thread_id, generation) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, sha256)
    REFERENCES thread_replication_content(thread_id, sha256) ON DELETE CASCADE
);
CREATE INDEX thread_replication_content_expiry
  ON thread_replication_content(thread_id, last_referenced_at);
CREATE INDEX thread_replication_content_lease_expiry
  ON thread_replication_content_leases(thread_id, lease_until);

-- Current lazy values remain available to idle/offline mirrors after their
-- journal entries expire. One pointer per entity, never one per revision.
CREATE TABLE thread_replication_entity_content (
  thread_id uuid NOT NULL REFERENCES thread_replication_clock(thread_id) ON DELETE CASCADE,
  entity_key text NOT NULL,
  sha256 text NOT NULL,
  seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(thread_id,entity_key),
  FOREIGN KEY(thread_id,sha256) REFERENCES thread_replication_content(thread_id,sha256) ON DELETE CASCADE
);
CREATE INDEX thread_replication_entity_content_hash ON thread_replication_entity_content(thread_id,sha256);
CREATE TRIGGER thread_purge_content BEFORE INSERT OR UPDATE ON thread_replication_entity_content
  FOR EACH ROW EXECUTE FUNCTION thread_purge_content_guard();

CREATE OR REPLACE FUNCTION thread_replication_enqueue(target uuid, entity_kind text, entity text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE clock thread_replication_clock; pending boolean;
BEGIN
  SELECT * INTO clock FROM thread_replication_clock WHERE thread_id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM thread_replication_entity_content WHERE thread_id=target AND entity_key=entity_kind||':'||entity;
  SELECT EXISTS(SELECT 1 FROM thread_replication_journal WHERE thread_id=target AND epoch=clock.epoch
      AND kind=entity_kind AND entity_id=entity AND payload IS NULL AND seq>clock.checkpoint_seq) INTO pending;
  UPDATE thread_replication_clock SET change_version=change_version+1,
    head_seq=head_seq+CASE WHEN pending THEN 0 ELSE 1 END WHERE thread_id=target RETURNING * INTO clock;
  IF pending THEN RETURN; END IF;
  INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id)
    VALUES(target,clock.epoch,clock.head_seq,entity_kind,entity);
END;
$$;

CREATE TRIGGER thread_purge_content BEFORE INSERT OR UPDATE ON thread_replication_snapshot_generations
  FOR EACH ROW EXECUTE FUNCTION thread_purge_content_guard();
CREATE TRIGGER thread_purge_content BEFORE INSERT OR UPDATE ON thread_replication_content_leases
  FOR EACH ROW EXECUTE FUNCTION thread_purge_content_guard();

-- Snapshot item previews can publish a hash without allocating a journal row.
-- Refresh its grace on every publication, including an already stored hash.
CREATE OR REPLACE FUNCTION thread_replication_item_preview(target uuid, value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE bytes bytea; hash text;
BEGIN
  bytes := convert_to(value::text,'UTF8');
  IF octet_length(bytes)<=24576 THEN RETURN jsonb_build_object('value',value); END IF;
  hash := encode(sha256(bytes),'hex');
  INSERT INTO thread_replication_content(thread_id,sha256,data,last_referenced_at)
    VALUES(target,hash,bytes,now())
    ON CONFLICT(thread_id,sha256) DO UPDATE SET last_referenced_at=now();
  RETURN jsonb_build_object('value',thread_replication_json_preview(value),'sha256',hash,'size',octet_length(bytes));
END;
$$;
