-- Worker records (kind 'worker', docs/linked-computers.md "Rekordy workerów i edycja zdalna"): the worker's home
-- gateway writes them; every other computer of the configuration group keeps a read-only copy. A worker or
-- computer record always names its home, so a copy can be told apart from a shared record.
ALTER TABLE config_items ADD CONSTRAINT config_items_home_named
  CHECK (kind NOT IN ('worker', 'computer') OR home_node_id <> '');
-- Copies are read and pruned by their home.
CREATE INDEX config_items_home ON config_items (owner_user_id, home_node_id, kind) WHERE home_node_id <> '';
-- Remote edits of worker settings are audited on both computers (computer.config.worker.sent / .received).
CREATE INDEX audit_log_worker_config ON audit_log (actor_user_id, created_at)
  WHERE action LIKE 'computer.config.worker.%';
-- A worker's own endpoint key is saved as a proxy of that worker only. It never becomes shared configuration:
-- the key stays on the worker's home computer.
ALTER TABLE proxies ADD COLUMN worker_scoped boolean NOT NULL DEFAULT false;
UPDATE proxies p SET worker_scoped = true
WHERE EXISTS (SELECT 1 FROM provider_instance_workers w WHERE w.proxy_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM provider_instances i WHERE i.proxy_id = p.id);
