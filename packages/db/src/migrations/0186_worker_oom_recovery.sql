-- Only a gateway continuation after a worker OOM may queue a recovery turn.
ALTER TABLE turns DROP CONSTRAINT turns_provider_not_queued;
ALTER TABLE turns ADD CONSTRAINT turns_provider_not_queued CHECK (
  status <> 'queued' OR trigger NOT IN ('provider', 'recovery')
  OR (trigger = 'recovery' AND resume_reason IS NOT DISTINCT FROM 'worker_oom')
);
CREATE UNIQUE INDEX turns_one_worker_oom_recovery ON turns (resumes_turn_id)
  WHERE trigger = 'recovery' AND resume_reason = 'worker_oom';
