import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { computerLink as link, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "../computers/store.ts";
import { bucketMessage, ensureUsageState, type BucketRow } from "./storage.ts";
import { addTotals } from "./totals.ts";

function groupUsageBuckets(rows: readonly (BucketRow & { group_revision: bigint })[], computerId: string) {
  const groups = new Map<bigint, { bucket: ui.UsageBucket; totals: ui.UsageTotals }>();

  for (const row of rows) {
    const revision = BigInt(row.group_revision);
    const part = bucketMessage(row, computerId);
    let group = groups.get(revision);

    if (!group) {
      const totals = create(ui.UsageTotalsSchema);
      group = { bucket: { ...part, revision, totals, activities: [] }, totals };
      groups.set(revision, group);
    }

    if (!part.totals?.reports) continue;
    addTotals(group.totals, part.totals);
    group.bucket.activities.push(...part.activities);
  }

  return [...groups.values()].map(({ bucket }) => {
    if (bucket.activities.length === 1 && bucket.activities[0]?.key === "unattributed") bucket.activities = [];

    return bucket;
  });
}

/** Source-local bounded replacement snapshots. No peer data or raw transcript crosses the link. */
export async function exportUsageBuckets(store: ComputerStore, request: link.UsageBucketsRequest) {
  const identity = await store.identity();

  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const state = yield* ensureUsageState(sql, store.owner);
      const limit = Math.min(Math.max(request.limit || 256, 1), 512);

      // A group replaces the same hour/provider/model/tier on old and new receivers.
      const rows = yield* sql<BucketRow & { group_revision: bigint }>`
        WITH changed AS (
          SELECT owner_user_id,bucket_start,provider,model,requested_service_tier,max(revision) AS group_revision
          FROM usage_buckets WHERE owner_user_id=${store.owner}::uuid AND revision>${request.afterRevision}
          GROUP BY owner_user_id,bucket_start,provider,model,requested_service_tier
          ORDER BY group_revision LIMIT ${limit + 1}
        )
        SELECT b.*,c.group_revision FROM changed c JOIN usage_activity_buckets b
        USING(owner_user_id,bucket_start,provider,model,requested_service_tier)
        ORDER BY c.group_revision,b.activity_key`;

      const buckets = groupUsageBuckets(rows, identity.node_id);
      const page = buckets.slice(0, limit);
      const last = page.at(-1);

      return create(link.UsageBucketsResponseSchema, {
        buckets: page,
        nextRevision: last?.revision ?? request.afterRevision,
        hasMore: buckets.length > limit,
        trackingSince: timestampFromDate(state.tracking_since),
      });
    }),
  );
}
