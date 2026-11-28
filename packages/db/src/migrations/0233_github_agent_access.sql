-- A native tool account carries an immutable repository identity and local grants.
-- The GitHub App token belongs exclusively to github_accounts.
ALTER TABLE connector_accounts
  ADD COLUMN github_account_id uuid,
  ADD COLUMN github_repository_id text,
  ADD COLUMN github_repository_name text,
  ADD COLUMN github_allow_writes boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT github_connector_owner FOREIGN KEY (owner_user_id, github_account_id)
    REFERENCES github_accounts(owner_user_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT connector_accounts_auth_kind_check,
  ADD CONSTRAINT connector_account_binding CHECK (
    CASE WHEN connector_type = 'github_repository' THEN
      github_account_id IS NOT NULL AND github_repository_id IS NOT NULL
      AND github_repository_id ~ '^[1-9][0-9]{0,19}$'
      AND github_repository_name IS NOT NULL AND github_repository_name = name
      AND github_repository_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'
      AND split_part(name, '/', 1) NOT IN ('.', '..') AND split_part(name, '/', 2) NOT IN ('.', '..')
      AND auth_kind = 'github_app' AND credentials IS NULL AND legacy_headers = '{}'::jsonb
      AND transport = 'http' AND url = 'https://api.github.com'
      AND NOT all_projects AND NOT no_project AND NOT all_bots
    ELSE auth_kind IN ('oauth', 'headers') AND github_account_id IS NULL
      AND github_repository_id IS NULL AND github_repository_name IS NULL AND NOT github_allow_writes END
  );
CREATE UNIQUE INDEX connector_github_repository ON connector_accounts(owner_user_id, github_account_id, github_repository_id)
  WHERE connector_type = 'github_repository';

-- Keep outstanding tool approvals and execution receipts tied to the same target.
CREATE FUNCTION immutable_github_connector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.connector_type = 'github_repository' OR NEW.connector_type = 'github_repository')
     AND ROW(OLD.id, OLD.owner_user_id, OLD.github_account_id, OLD.github_repository_id, OLD.connector_type)
       IS DISTINCT FROM ROW(NEW.id, NEW.owner_user_id, NEW.github_account_id, NEW.github_repository_id, NEW.connector_type)
  THEN RAISE EXCEPTION 'GitHub repository binding is immutable'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER immutable_github_connector BEFORE UPDATE OF id, owner_user_id, github_account_id, github_repository_id, connector_type
  ON connector_accounts FOR EACH ROW EXECUTE FUNCTION immutable_github_connector();

-- Deleting a legacy PAT also removes the linked GitHub account and its native grants.
-- Retain the audit trail and the update preference; completed connector calls follow their account.
ALTER TABLE connector_audit DROP CONSTRAINT connector_audit_account_id_fkey,
  ADD CONSTRAINT connector_audit_account_id_fkey FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE SET NULL;
ALTER TABLE connector_executions DROP CONSTRAINT connector_executions_account_id_fkey,
  ADD CONSTRAINT connector_executions_account_id_fkey FOREIGN KEY (account_id) REFERENCES connector_accounts(id) ON DELETE CASCADE;
ALTER TABLE github_update_accounts DROP CONSTRAINT github_update_accounts_owner_user_id_account_id_fkey,
  ADD CONSTRAINT github_update_accounts_owner_user_id_account_id_fkey FOREIGN KEY (owner_user_id,account_id)
    REFERENCES github_accounts(owner_user_id,id) ON DELETE SET NULL (account_id);
