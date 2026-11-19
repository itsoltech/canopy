import { clone, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { UsageIdentity } from "./accounting.ts";
import { counterWorker, incrementBucket, type UsageWorker } from "./storage.ts";
import { COUNT_FIELDS, COST_FIELDS, normalizeUsageTotals } from "./totals.ts";

export function validRequestedTier(value: string | undefined): string {
  return value && value.length <= 128 && !value.includes("\u0000") ? value : "";
}

/** Requested choice is immutable for a turn, including its auxiliary models. Caller holds the owner lock. */
export function freezeRequestedTier(sql: SqlClient.SqlClient, identity: UsageIdentity, candidate: string) {
  return Effect.gen(function* () {
    const { owner, subject, provider, counter } = identity;

    const rows = yield* sql<
      UsageWorker & { model: string; requested_service_tier: string; first_bucket: Date; totals: JsonValue }
    >`
      SELECT model,requested_service_tier,first_bucket,totals,worker_key AS id,worker_name AS name FROM usage_counters
      WHERE owner_user_id=${owner}::uuid AND subject_id=${subject} AND provider=${provider} AND counter_id=${counter}`;

    const tier = rows.find((row) => row.requested_service_tier)?.requested_service_tier || candidate;

    if (!tier) return "";

    for (const row of rows) {
      if (row.requested_service_tier) continue;
      const totals = normalizeUsageTotals(fromJson(ui.UsageTotalsSchema, row.totals));
      const reverse = clone(ui.UsageTotalsSchema, totals);

      for (const field of COUNT_FIELDS) reverse[field] = -reverse[field];

      for (const field of COST_FIELDS) reverse[field] = -reverse[field];
      const worker = counterWorker(identity.worker, row);
      const bucket = { owner, hour: row.first_bucket, provider, model: row.model, activity: identity.activity, worker };
      // Zero-value old buckets remain revisioned replacement snapshots so remote caches clear them.
      yield* incrementBucket(sql, bucket, "", reverse);
      yield* incrementBucket(sql, bucket, tier, totals);
    }

    yield* sql`UPDATE usage_counters SET requested_service_tier=${tier}
      WHERE owner_user_id=${owner}::uuid AND subject_id=${subject} AND provider=${provider}
        AND counter_id=${counter} AND requested_service_tier=''`;

    return tier;
  });
}
