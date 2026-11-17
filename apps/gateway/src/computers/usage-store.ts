import { toJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "./store.ts";
import { validateUsagePage } from "./usage-validation.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";

export async function usageCursor(store: ComputerStore, node: string, signal?: AbortSignal) {
  const { owner } = store;

  const rows = await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ cursor: string }>`SELECT cursor FROM remote_usage_state
        WHERE owner_user_id=${owner}::uuid AND node_id=${node}`;
    }).pipe(Effect.timeout("5 seconds"), queryFamily("computers.store"), queryRpc),
    { signal },
  );

  return BigInt(rows[0]?.cursor ?? 0);
}

/** A page is a replacement of source-owned buckets, committed together with its checkpoint. */
export async function saveUsagePage(
  store: ComputerStore,
  node: string,
  after: bigint,
  response: link.UsageBucketsResponse,
  limit: number,
  signal?: AbortSignal,
) {
  const since = validateUsagePage(node, after, response, limit);
  const { owner } = store;

  const buckets = response.buckets.map((bucket) => ({
    bucket_start: timestampDate(bucket.bucketStart!).toISOString(),
    provider: bucket.provider,
    model: bucket.model,
    requested_service_tier: bucket.requestedServiceTier,
    revision: String(bucket.revision),
    payload: toJson(ui.UsageBucketSchema, { ...bucket, computerId: node }),
  }));

  await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL statement_timeout = '10s'`;

          // A concurrent unlink waits for this page, then cascades it away. A revoked peer cannot recreate state.
          const peer = yield* sql`SELECT node_id FROM computer_peers
            WHERE owner_user_id=${owner}::uuid AND node_id=${node} AND via_node_id IS NULL FOR SHARE`;

          if (!peer.length)
            return yield* Effect.fail(new ConnectError("Computer is no longer linked", Code.PermissionDenied));
          yield* sql`INSERT INTO remote_usage_state(owner_user_id,node_id) VALUES(${owner}::uuid,${node}) ON CONFLICT DO NOTHING`;

          const state = yield* sql<{ cursor: string }>`SELECT cursor FROM remote_usage_state
            WHERE owner_user_id=${owner}::uuid AND node_id=${node} FOR UPDATE`;

          const current = BigInt(state[0]!.cursor);

          if (current > after && current >= response.nextRevision) return;

          if (current !== after)
            return yield* Effect.fail(new ConnectError("Usage cursor changed; resume from checkpoint", Code.Aborted));

          if (buckets.length)
            yield* sql`INSERT INTO remote_usage_buckets(owner_user_id,node_id,bucket_start,provider,model,requested_service_tier,payload,revision)
              SELECT ${owner}::uuid,${node},b.bucket_start,b.provider,b.model,b.requested_service_tier,b.payload,b.revision
              FROM jsonb_to_recordset(${JSON.stringify(buckets)}::jsonb)
                AS b(bucket_start timestamptz,provider text,model text,requested_service_tier text,payload jsonb,revision bigint)
              ON CONFLICT(owner_user_id,node_id,bucket_start,provider,model,requested_service_tier)
              DO UPDATE SET payload=excluded.payload,revision=excluded.revision
              WHERE remote_usage_buckets.revision < excluded.revision`;
          yield* sql`UPDATE remote_usage_state SET cursor=${String(response.nextRevision)}::bigint,
            tracking_since=${since.toISOString()}::timestamptz,updated_at=now(),has_more=${response.hasMore}
            WHERE owner_user_id=${owner}::uuid AND node_id=${node}`;
        }),
      );
    }).pipe(Effect.timeout("10 seconds"), queryFamily("computers.store"), queryRpc),
    { signal },
  );
}
