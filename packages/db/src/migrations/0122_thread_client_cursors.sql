-- A UI window publishes a checkpoint without walking the historical journal.
-- Further edits must allocate a new seq even when an older projection is unsealed.
ALTER TABLE thread_replication_clock ADD COLUMN checkpoint_seq bigint NOT NULL DEFAULT 0;
CREATE FUNCTION thread_replication_checkpoint_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch<>OLD.epoch THEN NEW.checkpoint_seq=0; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_replication_checkpoint_epoch BEFORE UPDATE OF epoch ON thread_replication_clock
  FOR EACH ROW EXECUTE FUNCTION thread_replication_checkpoint_epoch();
DROP INDEX thread_replication_pending;
CREATE INDEX thread_replication_pending ON thread_replication_journal(thread_id,epoch,kind,entity_id,seq) WHERE payload IS NULL;
CREATE OR REPLACE FUNCTION thread_replication_enqueue(target uuid, entity_kind text, entity text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE clock thread_replication_clock; pending boolean;
BEGIN
  SELECT * INTO clock FROM thread_replication_clock WHERE thread_id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT EXISTS(SELECT 1 FROM thread_replication_journal WHERE thread_id=target AND epoch=clock.epoch
      AND kind=entity_kind AND entity_id=entity AND payload IS NULL AND seq>clock.checkpoint_seq) INTO pending;
  UPDATE thread_replication_clock SET change_version=change_version+1,
    head_seq=head_seq+CASE WHEN pending THEN 0 ELSE 1 END WHERE thread_id=target RETURNING * INTO clock;
  IF pending THEN RETURN; END IF;
  INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id)
    VALUES(target,clock.epoch,clock.head_seq,entity_kind,entity);
END;
$$;
ALTER TABLE thread_replication_seed_entities ADD COLUMN turn_id text NOT NULL DEFAULT '';
ALTER TABLE thread_replication_seed_entities ADD COLUMN position bigint NOT NULL DEFAULT 0;
CREATE INDEX thread_replication_seed_position ON thread_replication_seed_entities(thread_id,kind,position,entity_id);
-- Re-index existing moved history incrementally on its next read.
UPDATE thread_replication_clock SET legacy_ready=false;
