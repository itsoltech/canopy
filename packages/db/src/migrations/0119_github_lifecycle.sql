ALTER TABLE github_mutation_receipts
  ALTER COLUMN pull_request_id DROP NOT NULL,
  ADD COLUMN thread_id uuid,
  ADD COLUMN repository_id text NOT NULL DEFAULT '',
  ADD COLUMN created_pr jsonb,
  ADD COLUMN existing_pr jsonb,
  ADD CONSTRAINT github_mutation_thread_owner FOREIGN KEY (owner_user_id,thread_id)
    REFERENCES threads(owner_user_id,id) ON DELETE CASCADE;
ALTER TABLE github_mutation_receipts DROP CONSTRAINT github_mutation_receipts_state_check;
ALTER TABLE github_mutation_receipts ADD CONSTRAINT github_mutation_receipts_state_check
  CHECK (state IN ('prepared','in_flight','succeeded','failed','uncertain','accepted'));
ALTER TABLE github_mutation_receipts ADD CONSTRAINT github_mutation_target
  CHECK (pull_request_id IS NOT NULL OR (action='create_pr' AND thread_id IS NOT NULL AND repository_id<>''));
