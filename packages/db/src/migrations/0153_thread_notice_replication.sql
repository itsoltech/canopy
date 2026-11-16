-- Raw transcript events are replicated through their item/turn projections and
-- thread header. Only notices have their own public entity keyed by event seq.
-- WHEN is evaluated before a deferred trigger is queued; token events therefore
-- do not acquire the journal lock or allocate phantom notice tombstones.
DROP TRIGGER computer_notice_change ON thread_events;

CREATE CONSTRAINT TRIGGER computer_notice_insert AFTER INSERT ON thread_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='notice')
  EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_notice_update AFTER UPDATE ON thread_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.kind='notice' OR NEW.kind='notice')
  EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_notice_delete AFTER DELETE ON thread_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.kind='notice')
  EXECUTE FUNCTION computer_thread_changed();
