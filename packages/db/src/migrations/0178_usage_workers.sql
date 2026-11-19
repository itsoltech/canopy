-- Subject watermarks and aggregates keep their worker after turn/worker retention.
-- The empty key is the share for which the gateway has no execution evidence.
ALTER TABLE usage_buckets
  ADD COLUMN worker_key text NOT NULL DEFAULT '' CHECK (worker_key=coalesce(nullif(worker_key,'')::uuid::text,'')),
  ADD COLUMN worker_name text NOT NULL DEFAULT '',
  DROP CONSTRAINT usage_buckets_pkey,
  ADD PRIMARY KEY(owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key,worker_key);
ALTER TABLE usage_counters
  ADD COLUMN worker_key text NOT NULL DEFAULT '' CHECK (worker_key=coalesce(nullif(worker_key,'')::uuid::text,'')),
  ADD COLUMN worker_name text NOT NULL DEFAULT '';

UPDATE usage_counters c SET worker_key=w.id::text,worker_name=left(w.name,200)
FROM threads t JOIN turns u ON u.thread_id=t.id
JOIN workers w ON w.id=t.worker_id AND (w.owner_user_id=t.owner_user_id OR w.owner_user_id IS NULL)
WHERE c.owner_user_id=t.owner_user_id AND c.thread_id=t.id AND c.thread_turn_id=u.id
  AND c.subject_id='thread:' || t.id::text AND c.counter_id=u.id::text;

UPDATE usage_counters c SET worker_key=w.id::text,worker_name=left(w.name,200)
FROM bots b JOIN bot_turns t ON t.bot_id=b.id
JOIN bot_harness_turns h ON h.bot_id=b.id AND h.turn_id=t.id
JOIN worker_commands cmd ON cmd.id=h.command_id AND cmd.worker_id=h.worker_id AND cmd.kind='runBotTurn'
JOIN workers w ON w.id=cmd.worker_id AND (w.owner_user_id=b.owner_user_id OR w.owner_user_id IS NULL)
WHERE c.owner_user_id=b.owner_user_id AND c.bot_id=b.id AND c.bot_turn_id=t.id
  AND c.subject_id='bot:' || b.id::text AND c.counter_id=t.id::text;

-- GenerateText normally uses an ephemeral command. Only a retained, owner-scoped
-- record of the command itself can identify the executing (possibly fallback) worker.
UPDATE usage_counters c SET worker_key=w.id::text,worker_name=left(w.name,200)
FROM worker_commands cmd JOIN workers w ON w.id=cmd.worker_id
LEFT JOIN threads t ON t.id=cmd.thread_id
WHERE cmd.kind='generateText' AND c.counter_id=cmd.id::text AND c.subject_id='generation:' || cmd.id::text
  AND c.thread_id IS NULL AND c.bot_id IS NULL
  AND (w.owner_user_id=c.owner_user_id OR w.owner_user_id IS NULL)
  AND (t.owner_user_id=c.owner_user_id OR (cmd.thread_id IS NULL AND w.owner_user_id=c.owner_user_id));

-- Reconstruct the same monetary coverage as 0165/0172 for legacy watermarks.
WITH retained AS (
  SELECT c.owner_user_id,c.first_bucket AS bucket_start,c.provider,c.model,c.requested_service_tier,
    CASE WHEN c.bot_id IS NOT NULL THEN 'bot:' || c.bot_id::text
         WHEN c.thread_id IS NOT NULL THEN 'thread'
         ELSE 'generation' END AS activity_key,
    c.worker_key,max(c.worker_name) AS worker_name,
    coalesce(sum(t."inputTokens"),0)::bigint AS input_tokens,
    coalesce(sum(t."outputTokens"),0)::bigint AS output_tokens,
    coalesce(sum(t."cachedInputTokens"),0)::bigint AS cached_input_tokens,
    coalesce(sum(t."cacheWriteInputTokens"),0)::bigint AS cache_write_input_tokens,
    coalesce(sum(t."reasoningOutputTokens"),0)::bigint AS reasoning_output_tokens,
    coalesce(sum(t."reportedCostUsd"),0)::double precision AS reported_cost_usd,
    coalesce(sum(t."reports"),0)::bigint AS reports,
    coalesce(sum(t."unknownCostReports"),0)::bigint AS unknown_cost_reports,
    coalesce(sum(t."estimatedCostUsd"),0)::double precision AS estimated_cost_usd,
    coalesce(sum(CASE WHEN coverage.legacy THEN t."reports" ELSE t."unknownEstimatedCostReports" END),0)
      ::bigint AS unknown_estimated_cost_reports,
    coalesce(sum(CASE WHEN coverage.legacy AND coverage.complete_reported THEN t."reportedCostUsd" ELSE t."effectiveCostUsd" END),0)
      ::double precision AS effective_cost_usd,
    coalesce(sum(CASE WHEN coverage.legacy AND NOT coverage.complete_reported THEN t."reports" ELSE t."unknownEffectiveCostReports" END),0)
      ::bigint AS unknown_effective_cost_reports,
    coalesce(sum(CASE WHEN coverage.legacy AND coverage.complete_reported THEN t."reports" ELSE t."effectiveReportedCostReports" END),0)
      ::bigint AS effective_reported_cost_reports,
    coalesce(sum(t."effectiveEstimatedCostReports"),0)::bigint AS effective_estimated_cost_reports
  FROM usage_counters c
  CROSS JOIN LATERAL jsonb_to_record(c.totals) AS t(
    "inputTokens" bigint, "outputTokens" bigint, "cachedInputTokens" bigint,
    "cacheWriteInputTokens" bigint, "reasoningOutputTokens" bigint, "reportedCostUsd" double precision,
    "reports" bigint, "unknownCostReports" bigint, "estimatedCostUsd" double precision,
    "unknownEstimatedCostReports" bigint, "effectiveCostUsd" double precision,
    "unknownEffectiveCostReports" bigint, "effectiveReportedCostReports" bigint,
    "effectiveEstimatedCostReports" bigint
  )
  CROSS JOIN LATERAL (
    SELECT
      NOT c.totals ?| ARRAY['unknownEffectiveCostReports','effectiveReportedCostReports','effectiveEstimatedCostReports'] AS legacy,
      coalesce(t."unknownCostReports",0)=0 AS complete_reported
  ) coverage
  WHERE c.worker_key<>''
  GROUP BY c.owner_user_id,c.first_bucket,c.provider,c.model,c.requested_service_tier,activity_key,c.worker_key
)
INSERT INTO usage_buckets(
  owner_user_id, bucket_start, provider, model, requested_service_tier, activity_key, bot_name, worker_key, worker_name,
  input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens,
  reported_cost_usd, reports, unknown_cost_reports, estimated_cost_usd, unknown_estimated_cost_reports,
  effective_cost_usd, unknown_effective_cost_reports, effective_reported_cost_reports,
  effective_estimated_cost_reports, revision
)
SELECT
  a.owner_user_id, a.bucket_start, a.provider, a.model, a.requested_service_tier, a.activity_key,
  b.bot_name, a.worker_key, a.worker_name, a.input_tokens, a.output_tokens, a.cached_input_tokens, a.cache_write_input_tokens,
  a.reasoning_output_tokens, a.reported_cost_usd, a.reports, a.unknown_cost_reports,
  a.estimated_cost_usd, a.unknown_estimated_cost_reports, a.effective_cost_usd,
  a.unknown_effective_cost_reports, a.effective_reported_cost_reports,
  a.effective_estimated_cost_reports,
  -- The wire key excludes activity and worker. One fresh revision per changed wire key.
  s.revision+dense_rank() OVER (PARTITION BY a.owner_user_id ORDER BY a.bucket_start,a.provider,a.model,a.requested_service_tier)
FROM retained a
JOIN usage_buckets b USING(owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key)
JOIN usage_state s USING(owner_user_id);

WITH attributed AS (
  SELECT owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(cached_input_tokens) AS cached_input_tokens,
    sum(cache_write_input_tokens) AS cache_write_input_tokens,
    sum(reasoning_output_tokens) AS reasoning_output_tokens,
    sum(reported_cost_usd) AS reported_cost_usd,
    sum(reports) AS reports,
    sum(unknown_cost_reports) AS unknown_cost_reports,
    sum(estimated_cost_usd) AS estimated_cost_usd,
    sum(unknown_estimated_cost_reports) AS unknown_estimated_cost_reports,
    sum(effective_cost_usd) AS effective_cost_usd,
    sum(unknown_effective_cost_reports) AS unknown_effective_cost_reports,
    sum(effective_reported_cost_reports) AS effective_reported_cost_reports,
    sum(effective_estimated_cost_reports) AS effective_estimated_cost_reports
  FROM usage_buckets WHERE worker_key<>''
  GROUP BY owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key
)
UPDATE usage_buckets b SET
  input_tokens=b.input_tokens-a.input_tokens,
  output_tokens=b.output_tokens-a.output_tokens,
  cached_input_tokens=b.cached_input_tokens-a.cached_input_tokens,
  cache_write_input_tokens=b.cache_write_input_tokens-a.cache_write_input_tokens,
  reasoning_output_tokens=b.reasoning_output_tokens-a.reasoning_output_tokens,
  reported_cost_usd=CASE WHEN b.reports=a.reports THEN 0 ELSE greatest(0,b.reported_cost_usd-a.reported_cost_usd) END,
  reports=b.reports-a.reports,
  unknown_cost_reports=b.unknown_cost_reports-a.unknown_cost_reports,
  estimated_cost_usd=CASE WHEN b.reports=a.reports THEN 0 ELSE greatest(0,b.estimated_cost_usd-a.estimated_cost_usd) END,
  unknown_estimated_cost_reports=b.unknown_estimated_cost_reports-a.unknown_estimated_cost_reports,
  effective_cost_usd=CASE
    WHEN b.effective_reported_cost_reports=a.effective_reported_cost_reports
      AND b.effective_estimated_cost_reports=a.effective_estimated_cost_reports THEN 0
    ELSE greatest(0,b.effective_cost_usd-a.effective_cost_usd) END,
  unknown_effective_cost_reports=b.unknown_effective_cost_reports-a.unknown_effective_cost_reports,
  effective_reported_cost_reports=b.effective_reported_cost_reports-a.effective_reported_cost_reports,
  effective_estimated_cost_reports=b.effective_estimated_cost_reports-a.effective_estimated_cost_reports
FROM attributed a
WHERE b.worker_key='' AND b.activity_key=a.activity_key
  AND b.owner_user_id=a.owner_user_id AND b.bucket_start=a.bucket_start AND b.provider=a.provider
  AND b.model=a.model AND b.requested_service_tier=a.requested_service_tier;

UPDATE usage_state s SET revision=b.revision,updated_at=now()
FROM (
  SELECT owner_user_id,max(revision) AS revision
  FROM usage_buckets GROUP BY owner_user_id
) b WHERE b.owner_user_id=s.owner_user_id AND b.revision>s.revision;

-- A receiver upgraded after its source may have cached that source's latest revision
-- without the worker breakdown. Replay pages while the offline snapshots stay usable.
UPDATE remote_usage_state SET cursor=0,has_more=true;

DROP VIEW usage_activity_buckets;
CREATE VIEW usage_activity_buckets AS
SELECT b.*,left(coalesce(nullif(bot.configuration->>'name',''),b.bot_name),80) AS activity_bot_name,
  left(coalesce(nullif(w.name,''),b.worker_name),200) AS usage_worker_name
FROM usage_buckets b
LEFT JOIN bots bot ON bot.owner_user_id=b.owner_user_id
  AND bot.id=CASE WHEN b.activity_key LIKE 'bot:%' THEN substring(b.activity_key FROM 5)::uuid END
LEFT JOIN workers w ON w.id=nullif(b.worker_key,'')::uuid AND (w.owner_user_id=b.owner_user_id OR w.owner_user_id IS NULL);
