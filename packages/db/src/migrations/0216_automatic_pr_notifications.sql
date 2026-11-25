-- A watch without a tool call belongs to the thread's PR link.
ALTER TABLE pr_check_watches ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE pr_check_watches ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE pr_check_watches ADD CONSTRAINT pr_check_watch_origin CHECK ((call_id IS NULL) = (expires_at IS NULL));
ALTER TABLE pr_check_watches ADD COLUMN conflicting boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX pr_check_watches_automatic_active ON pr_check_watches (owner_user_id,thread_id,pull_request_id)
  WHERE call_id IS NULL AND status='active';
