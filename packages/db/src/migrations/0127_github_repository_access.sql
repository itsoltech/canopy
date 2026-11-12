ALTER TABLE github_accounts ADD COLUMN account_type text NOT NULL DEFAULT 'User';
ALTER TABLE github_accounts ADD COLUMN catalog_fingerprint text NOT NULL DEFAULT '';
UPDATE github_accounts SET account_type='Bot' WHERE login LIKE '%[bot]';

-- Repository resolution starts with the owner's installation index, without probing accounts.
CREATE INDEX github_repository_access_name
  ON github_installation_repositories(owner_user_id,lower(full_name),account_id)
  INCLUDE (repository_id,installation_id);
