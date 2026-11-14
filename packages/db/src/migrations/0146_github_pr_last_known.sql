-- The last summary each owner saw for a pull request, bound to the account that read it. It survives token
-- rotation, restarts and cache retention, so linked pull requests keep their title, state and checks until the
-- next refresh. The refresh result keeps a specific, user-facing reason when the last attempt failed.
ALTER TABLE github_pull_requests ADD COLUMN summary jsonb;
ALTER TABLE github_pull_requests ADD COLUMN summary_account_id uuid;
ALTER TABLE github_pull_requests ADD COLUMN refresh_detail text NOT NULL DEFAULT '';
ALTER TABLE github_pull_requests ADD COLUMN refreshed_at timestamptz;
