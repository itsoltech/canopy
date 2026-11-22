-- Republish bot steer authors for clients resuming from a saved checkpoint.
-- The existing change trigger also enqueues them for forks. Sealed records stay immutable.
UPDATE turn_steers SET bot_call_id = bot_call_id
WHERE bot_call_id IS NOT NULL AND status = 'delivered';
