import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { addTotals } from "./totals.ts";
import { bucketMessage, ensureUsageState, type BucketRow } from "./storage.ts";

interface SourceRow {
  node_id: string;
  name: string;
  status: string;
  via_node_id: string | null;
  has_more: boolean | null;
  capabilities: string[];
  tracking_since: Date | null;
  updated_at: Date | null;
}

export function usageWindow(request: ui.GetUsageStatsRequest, now = new Date()) {
  const days = request.days || 30;

  if (![1, 7, 30, 90].includes(days)) throw new ConnectError("Choose 1, 7, 30 or 90 days", Code.InvalidArgument);

  if (request.provider && !["claude", "codex", "grok"].includes(request.provider))
    throw new ConnectError("Choose an available provider", Code.InvalidArgument);

  if (
    request.requestedServiceTier !== undefined &&
    (request.requestedServiceTier.length > 128 || request.requestedServiceTier.includes("\u0000"))
  )
    throw new ConnectError("Choose an available requested speed", Code.InvalidArgument);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);

  return { start, end: now };
}

function breakdown(values: Map<string, ui.UsageTotals>): ui.UsageBreakdown[] {
  return [...values]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, totals]) => create(ui.UsageBreakdownSchema, { key, totals }));
}

function accumulate(values: Map<string, ui.UsageTotals>, key: string, added: ui.UsageTotals) {
  const totals = values.get(key) ?? create(ui.UsageTotalsSchema);
  addTotals(totals, added);
  values.set(key, totals);
}

/** Local database only: peer snapshots are refreshed independently by linked-computer sync. */
export function getUsageStats(sql: SqlClient.SqlClient, owner: string, request: ui.GetUsageStatsRequest) {
  return Effect.gen(function* () {
    const { start, end } = usageWindow(request);
    const state = yield* ensureUsageState(sql, owner);

    const identity = (yield* sql<{ node_id: string; name: string }>`SELECT node_id,name FROM computer_identity
      WHERE owner_user_id=${owner}::uuid`)[0];

    const localId = identity?.node_id ?? state.computer_id;

    const sources = [
      create(ui.UsageSourceSchema, {
        computerId: localId,
        name: identity?.name ?? "Server",
        local: true,
        online: true,
        status: "ready",
        trackingSince: timestampFromDate(state.tracking_since),
        updatedAt: timestampFromDate(end),
      }),
    ];

    const peers = yield* sql<SourceRow>`SELECT p.node_id,coalesce(nullif(p.display_name,''),p.name) AS name,
      p.status,p.via_node_id,p.capabilities,s.has_more,s.tracking_since,s.updated_at FROM computer_peers p LEFT JOIN remote_usage_state s
      ON s.owner_user_id=p.owner_user_id AND s.node_id=p.node_id WHERE p.owner_user_id=${owner}::uuid`;

    for (const peer of peers)
      sources.push(
        create(ui.UsageSourceSchema, {
          computerId: peer.node_id,
          name: peer.name,
          online: peer.status === "connected",
          status: sourceStatus(peer, end),
          ...(peer.tracking_since && { trackingSince: timestampFromDate(peer.tracking_since) }),
          ...(peer.updated_at && { updatedAt: timestampFromDate(peer.updated_at) }),
        }),
      );
    const selected = sources.filter((source) => !request.computerId || source.computerId === request.computerId);

    if (request.computerId && !selected.length)
      return yield* Effect.fail(new ConnectError("Computer is unavailable", Code.NotFound));
    const buckets: ui.UsageBucket[] = [];

    if (!request.computerId || request.computerId === localId) {
      const rows = yield* sql<BucketRow>`SELECT * FROM usage_buckets WHERE owner_user_id=${owner}::uuid
        AND bucket_start>=${start} AND bucket_start<=${end}
        ${request.provider ? sql`AND provider=${request.provider}` : sql``}
        ${request.requestedServiceTier !== undefined ? sql`AND requested_service_tier=${request.requestedServiceTier}` : sql``}`;

      buckets.push(...rows.map((row) => bucketMessage(row, localId)));
    }

    const remote = yield* sql<{ payload: JsonValue }>`SELECT b.payload FROM remote_usage_buckets b
      JOIN computer_peers p ON p.owner_user_id=b.owner_user_id AND p.node_id=b.node_id
      WHERE b.owner_user_id=${owner}::uuid AND p.via_node_id IS NULL
        AND b.bucket_start>=${start} AND b.bucket_start<=${end}
        ${request.provider ? sql`AND b.provider=${request.provider}` : sql``}
        ${request.requestedServiceTier !== undefined ? sql`AND b.requested_service_tier=${request.requestedServiceTier}` : sql``}
        ${request.computerId ? sql`AND b.node_id=${request.computerId}` : sql``}`;

    buckets.push(...remote.map((row) => fromJson(ui.UsageBucketSchema, row.payload)));

    const incomplete = peers.some(
      (peer) =>
        (!request.computerId || request.computerId === peer.node_id) &&
        (peer.via_node_id !== null || peer.has_more !== false),
    );

    const result = summarizeUsage(buckets, sources, selected, start, end);
    result.partial ||= incomplete;

    return result;
  });
}

function summarizeUsage(
  buckets: ui.UsageBucket[],
  sources: ui.UsageSource[],
  selected: ui.UsageSource[],
  start: Date,
  end: Date,
): ui.GetUsageStatsResponse {
  const totals = create(ui.UsageTotalsSchema);
  const days = new Map<string, ui.UsageTotals>();
  const dayProviders = new Map<string, Map<string, ui.UsageTotals>>();
  const providers = new Map<string, ui.UsageTotals>();
  const models = new Map<string, ui.UsageTotals>();
  const speeds = new Map<string, ui.UsageTotals>();

  for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1))
    days.set(day.toISOString(), create(ui.UsageTotalsSchema));

  for (const bucket of buckets) {
    if (!bucket.totals || !bucket.bucketStart || bucket.totals.reports === 0n) continue;
    const day = timestampDate(bucket.bucketStart);
    day.setUTCHours(0, 0, 0, 0);
    addTotals(totals, bucket.totals);
    accumulate(days, day.toISOString(), bucket.totals);
    const daily = dayProviders.get(day.toISOString()) ?? new Map<string, ui.UsageTotals>();
    accumulate(daily, bucket.provider, bucket.totals);
    dayProviders.set(day.toISOString(), daily);
    accumulate(providers, bucket.provider, bucket.totals);
    accumulate(models, bucket.model, bucket.totals);
    accumulate(speeds, bucket.requestedServiceTier, bucket.totals);
  }

  const partial =
    totals.unknownEffectiveCostReports > 0n ||
    selected.some(
      (source) =>
        source.status !== "ready" ||
        !source.online ||
        !source.trackingSince ||
        timestampDate(source.trackingSince) > start ||
        (!source.local && (!source.updatedAt || end.getTime() - timestampDate(source.updatedAt).getTime() > 120_000)),
    );

  return create(ui.GetUsageStatsResponseSchema, {
    totals,
    days: [...days].map(([day, values]) => ({
      day: timestampFromDate(new Date(day)),
      totals: values,
      providers: breakdown(dayProviders.get(day) ?? new Map()),
    })),
    providers: breakdown(providers),
    models: breakdown(models),
    speeds: breakdown(speeds),
    sources,
    startsAt: timestampFromDate(start),
    endsAt: timestampFromDate(end),
    partial,
  });
}

function sourceStatus(peer: SourceRow, end: Date): string {
  if (peer.via_node_id) return "relay";

  if (!peer.capabilities.includes("usage_stats_v1")) return "unsupported";

  if (peer.status !== "connected") return "offline";

  if (peer.has_more !== false || !peer.tracking_since) return "syncing";

  if (!peer.updated_at || end.getTime() - peer.updated_at.getTime() > 120_000) return "stale";

  return "ready";
}
