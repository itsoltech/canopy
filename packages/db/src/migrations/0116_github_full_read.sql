CREATE TABLE github_update_accounts (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  FOREIGN KEY (owner_user_id,account_id) REFERENCES github_accounts(owner_user_id,id)
);
CREATE INDEX github_pr_cache_content_retention ON github_pr_cache(owner_user_id,verified_at,cache_key);
