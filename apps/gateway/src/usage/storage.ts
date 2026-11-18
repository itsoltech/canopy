import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { UsageActivity } from "./activity.ts";

export interface UsageState {
  computer_id: string;
  tracking_since: Date;
  updated_at: Date;
  revision: bigint;
}

export interface BucketRow {
  bucket_start: Date;
  provider: string;
  model: string;
  requested_service_tier: string;
  activity_key: string;
  activity_bot_name: string;
  input_tokens: bigint;
  output_tokens: bigint;
  cached_input_tokens: bigint;
  cache_write_input_tokens: bigint;
  reasoning_output_tokens: bigint;
  reported_cost_usd: number;
  estimated_cost_usd: number;
  effective_cost_usd: number;
  unknown_estimated_cost_reports: bigint;
  unknown_effective_cost_reports: bigint;
  effective_reported_cost_reports: bigint;
  effective_estimated_cost_reports: bigint;
  reports: bigint;
  unknown_cost_reports: bigint;
  revision: bigint;
}

export function ensureUsageState(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO usage_state(owner_user_id,computer_id)
      SELECT ${owner}::uuid,coalesce((SELECT node_id FROM computer_identity WHERE owner_user_id=${owner}::uuid),'server:' || ${owner})
      ON CONFLICT DO NOTHING`;

    // SAFETY: the insert establishes this owner row or fails its user foreign key.
    return (yield* sql<UsageState>`SELECT * FROM usage_state WHERE owner_user_id=${owner}::uuid`)[0]!;
  });
}

export function bucketMessage(row: BucketRow, computerId: string): ui.UsageBucket {
  const totals = create(ui.UsageTotalsSchema, {
    inputTokens: BigInt(row.input_tokens),
    outputTokens: BigInt(row.output_tokens),
    cachedInputTokens: BigInt(row.cached_input_tokens),
    cacheWriteInputTokens: BigInt(row.cache_write_input_tokens),
    reasoningOutputTokens: BigInt(row.reasoning_output_tokens),
    reportedCostUsd: row.reported_cost_usd,
    estimatedCostUsd: row.estimated_cost_usd,
    effectiveCostUsd: row.effective_cost_usd,
    unknownEstimatedCostReports: BigInt(row.unknown_estimated_cost_reports),
    unknownEffectiveCostReports: BigInt(row.unknown_effective_cost_reports),
    effectiveReportedCostReports: BigInt(row.effective_reported_cost_reports),
    effectiveEstimatedCostReports: BigInt(row.effective_estimated_cost_reports),
    reports: BigInt(row.reports),
    unknownCostReports: BigInt(row.unknown_cost_reports),
  });

  return create(ui.UsageBucketSchema, {
    bucketStart: timestampFromDate(row.bucket_start),
    provider: row.provider,
    model: row.model,
    revision: BigInt(row.revision),
    computerId,
    requestedServiceTier: row.requested_service_tier,
    totals,
    activities: [{ key: row.activity_key, botName: row.activity_bot_name, totals }],
  });
}

/** Caller holds usage_state's owner lock; revision order therefore follows commit order. */
export function incrementBucket(
  sql: SqlClient.SqlClient,
  owner: string,
  hour: Date,
  provider: string,
  model: string,
  requestedServiceTier: string,
  activity: UsageActivity,
  delta: ui.UsageTotals,
) {
  return Effect.gen(function* () {
    const state = yield* sql<{ revision: bigint }>`UPDATE usage_state SET revision=revision+1,updated_at=now()
      WHERE owner_user_id=${owner}::uuid RETURNING revision`;

    // SAFETY: the caller holds the existing owner state row lock until this transaction commits.
    yield* sql`INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key,bot_name,input_tokens,output_tokens,
      cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,reported_cost_usd,reports,unknown_cost_reports,
      estimated_cost_usd,unknown_estimated_cost_reports,effective_cost_usd,unknown_effective_cost_reports,
      effective_reported_cost_reports,effective_estimated_cost_reports,revision)
      VALUES(${owner}::uuid,${hour},${provider},${model},${requestedServiceTier},${activity.key},${activity.botName ?? ""},${delta.inputTokens},${delta.outputTokens},
        ${delta.cachedInputTokens},${delta.cacheWriteInputTokens},${delta.reasoningOutputTokens},${delta.reportedCostUsd},
        ${delta.reports},${delta.unknownCostReports},${delta.estimatedCostUsd},${delta.unknownEstimatedCostReports},
        ${delta.effectiveCostUsd},${delta.unknownEffectiveCostReports},${delta.effectiveReportedCostReports},
        ${delta.effectiveEstimatedCostReports},${state[0]!.revision})
      ON CONFLICT(owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key) DO UPDATE SET
        bot_name=coalesce(nullif(excluded.bot_name,''),usage_buckets.bot_name),
        input_tokens=usage_buckets.input_tokens+excluded.input_tokens,
        output_tokens=usage_buckets.output_tokens+excluded.output_tokens,
        cached_input_tokens=usage_buckets.cached_input_tokens+excluded.cached_input_tokens,
        cache_write_input_tokens=usage_buckets.cache_write_input_tokens+excluded.cache_write_input_tokens,
        reasoning_output_tokens=usage_buckets.reasoning_output_tokens+excluded.reasoning_output_tokens,
        reported_cost_usd=CASE WHEN usage_buckets.reports+excluded.reports=0 THEN 0
          ELSE greatest(0,usage_buckets.reported_cost_usd+excluded.reported_cost_usd) END,
        estimated_cost_usd=CASE WHEN usage_buckets.reports+excluded.reports=0 THEN 0
          ELSE greatest(0,usage_buckets.estimated_cost_usd+excluded.estimated_cost_usd) END,
        effective_cost_usd=CASE WHEN usage_buckets.reports+excluded.reports=0 THEN 0
          ELSE greatest(0,usage_buckets.effective_cost_usd+excluded.effective_cost_usd) END,
        unknown_estimated_cost_reports=usage_buckets.unknown_estimated_cost_reports+excluded.unknown_estimated_cost_reports,
        unknown_effective_cost_reports=usage_buckets.unknown_effective_cost_reports+excluded.unknown_effective_cost_reports,
        effective_reported_cost_reports=usage_buckets.effective_reported_cost_reports+excluded.effective_reported_cost_reports,
        effective_estimated_cost_reports=usage_buckets.effective_estimated_cost_reports+excluded.effective_estimated_cost_reports,
        reports=usage_buckets.reports+excluded.reports,
        unknown_cost_reports=usage_buckets.unknown_cost_reports+excluded.unknown_cost_reports,
        revision=excluded.revision`;
  });
}

/** Acquire before transcript mutations, whose mirror journal also serializes writes. */
export function lockUsageOwner(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    yield* ensureUsageState(sql, owner);
    yield* sql`SELECT revision FROM usage_state WHERE owner_user_id=${owner}::uuid FOR UPDATE`;
  });
}
