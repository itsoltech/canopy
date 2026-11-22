ALTER TABLE connector_accounts ADD COLUMN all_projects boolean NOT NULL DEFAULT false;

-- A shared project's record may arrive after the account holding its grant.
CREATE TABLE connector_project_grants (
  account_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  PRIMARY KEY (account_id, project_id)
);

WITH placement AS (
  SELECT project_id, worker_id FROM project_workspaces WHERE archived_at IS NULL
  UNION
  SELECT project_id, worker_id FROM threads WHERE runtime = 'worker' AND deleted_at IS NULL
)
INSERT INTO connector_project_grants(account_id, project_id)
SELECT a.id, coalesce(i.global_id, p.id::text)::uuid
FROM connector_accounts a
JOIN projects p ON p.owner_user_id = a.owner_user_id
LEFT JOIN config_items i ON i.owner_user_id = p.owner_user_id AND i.kind = 'project'
  AND i.local_id = p.id::text AND i.unsupported = ''
WHERE p.kind = 'project' AND p.archived_at IS NULL AND NOT p.config_deleted
  -- Linked computers may have placements and worker grants this database cannot see.
  AND NOT EXISTS (
    SELECT 1 FROM computer_peers c WHERE c.owner_user_id = a.owner_user_id
      AND c.share_config AND c.peer_share_config
  )
  AND EXISTS (SELECT 1 FROM placement w WHERE w.project_id = p.id)
  AND NOT EXISTS (
    SELECT 1 FROM placement w WHERE w.project_id = p.id AND NOT EXISTS (
      SELECT 1 FROM connector_worker_grants g WHERE g.account_id = a.id AND g.worker_id = w.worker_id
    )
  )
ON CONFLICT DO NOTHING;

WITH migrated AS (
  UPDATE connector_accounts SET all_projects = all_workers, revision = revision + 1
  RETURNING id, owner_user_id, revision
)
UPDATE github_accounts g SET connector_revision = m.revision FROM migrated m
WHERE g.connector_account_id = m.id AND g.owner_user_id = m.owner_user_id
  AND g.connector_revision = m.revision - 1;

DROP TABLE connector_worker_grants;
ALTER TABLE connector_accounts DROP COLUMN all_workers;
