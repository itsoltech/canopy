-- Independent estimate snapshots and a per-counter best-available amount prevent overlap.
ALTER TABLE usage_buckets
  ADD COLUMN estimated_cost_usd double precision NOT NULL DEFAULT 0,
  ADD COLUMN unknown_estimated_cost_reports bigint NOT NULL DEFAULT 0,
  ADD COLUMN effective_cost_usd double precision NOT NULL DEFAULT 0,
  ADD COLUMN unknown_effective_cost_reports bigint NOT NULL DEFAULT 0,
  ADD COLUMN effective_reported_cost_reports bigint NOT NULL DEFAULT 0,
  ADD COLUMN effective_estimated_cost_reports bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_counters ADD COLUMN pricing_version text NOT NULL DEFAULT '';

-- Old sums cannot separate partial historical USD from complete counters once watermarks
-- have been purged. Preserve every independent reported USD; effective cost conservatively
-- includes complete live counters, or the entire bucket when all reports are complete.
UPDATE usage_buckets SET
  unknown_estimated_cost_reports=reports,
  effective_cost_usd=CASE WHEN unknown_cost_reports=0 THEN reported_cost_usd ELSE 0 END,
  effective_reported_cost_reports=CASE WHEN unknown_cost_reports=0 THEN reports ELSE 0 END;
WITH complete_live AS (
  SELECT owner_user_id,first_bucket,provider,model,requested_service_tier,
    sum(coalesce((totals->>'reportedCostUsd')::double precision,0)) AS cost,
    count(*) AS reports
  FROM usage_counters
  WHERE coalesce((totals->>'unknownCostReports')::bigint,0)=0
  GROUP BY owner_user_id,first_bucket,provider,model,requested_service_tier
)
UPDATE usage_buckets b SET effective_cost_usd=c.cost,effective_reported_cost_reports=c.reports
FROM complete_live c
WHERE b.unknown_cost_reports>0 AND c.owner_user_id=b.owner_user_id
  AND c.first_bucket=b.bucket_start AND c.provider=b.provider AND c.model=b.model
  AND c.requested_service_tier=b.requested_service_tier;
UPDATE usage_buckets SET unknown_effective_cost_reports=reports-effective_reported_cost_reports;

-- Versioned replacement snapshots must reach already-synchronized peers after migration.
WITH numbered AS (
  SELECT owner_user_id,bucket_start,provider,model,requested_service_tier,
    row_number() OVER (PARTITION BY owner_user_id ORDER BY bucket_start,provider,model,requested_service_tier) AS offset
  FROM usage_buckets
)
UPDATE usage_buckets b SET revision=s.revision+n.offset
FROM numbered n,usage_state s
WHERE s.owner_user_id=b.owner_user_id AND n.owner_user_id=b.owner_user_id
  AND n.bucket_start=b.bucket_start AND n.provider=b.provider AND n.model=b.model
  AND n.requested_service_tier=b.requested_service_tier;
UPDATE usage_state s SET revision=(SELECT max(b.revision) FROM usage_buckets b WHERE b.owner_user_id=s.owner_user_id),
  updated_at=now()
WHERE EXISTS(SELECT 1 FROM usage_buckets b WHERE b.owner_user_id=s.owner_user_id);
