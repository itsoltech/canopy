-- A worker heartbeat only moves workers.last_seen_at, which no thread, mirror or watch reads from the change log.
-- Every UPDATE of workers was a metadata change: each heartbeat re-queued the replication head of every thread on
-- that worker and made every thread watch and mirror revalidate. Inserts and deletes still always count.
DROP TRIGGER computer_worker_change ON workers;
CREATE CONSTRAINT TRIGGER computer_worker_change AFTER INSERT OR DELETE ON workers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed('metadata');
CREATE CONSTRAINT TRIGGER computer_worker_update AFTER UPDATE ON workers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'last_seen_at') IS DISTINCT FROM (to_jsonb(NEW) - 'last_seen_at'))
  EXECUTE FUNCTION computer_thread_changed('metadata');
