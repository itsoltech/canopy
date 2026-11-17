import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { computerLink as link } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "../computers/store.ts";
import { bucketMessage, ensureUsageState, type BucketRow } from "./storage.ts";

/** Source-local bounded replacement snapshots. No peer data or raw transcript crosses the link. */
export async function exportUsageBuckets(store: ComputerStore, request: link.UsageBucketsRequest) {
  const identity = await store.identity();

  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const state = yield* ensureUsageState(sql, store.owner);
      const limit = Math.min(Math.max(request.limit || 256, 1), 512);

      const rows = yield* sql<BucketRow>`SELECT * FROM usage_buckets WHERE owner_user_id=${store.owner}::uuid
      AND revision>${request.afterRevision} ORDER BY revision LIMIT ${limit + 1}`;

      const page = rows.slice(0, limit);
      const last = page.at(-1);

      return create(link.UsageBucketsResponseSchema, {
        buckets: page.map((row) => bucketMessage(row, identity.node_id)),
        nextRevision: last ? BigInt(last.revision) : request.afterRevision,
        hasMore: rows.length > limit,
        trackingSince: timestampFromDate(state.tracking_since),
      });
    }),
  );
}
