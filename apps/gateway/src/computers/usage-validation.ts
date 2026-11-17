import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

const invalid = () => new ConnectError("Invalid linked usage page", Code.DataLoss);

/** Reject source substitution and malformed cursors before opening a write transaction. */
export function validateUsagePage(node: string, after: bigint, response: link.UsageBucketsResponse, limit: number) {
  if (
    !/^[a-f0-9]{64}$/.test(node) ||
    after < 0n ||
    response.buckets.length > limit ||
    response.nextRevision < after ||
    (response.hasMore && response.nextRevision === after) ||
    !response.trackingSince
  )
    throw invalid();
  const since = timestampDate(response.trackingSince);

  if (!Number.isFinite(since.getTime())) throw invalid();
  let previous = after;
  const keys = new Set<string>();

  for (const bucket of response.buckets) {
    if (
      !bucket.bucketStart ||
      !bucket.totals ||
      !["claude", "codex", "grok"].includes(bucket.provider) ||
      bucket.model.length > 512 ||
      bucket.model.includes("\u0000") ||
      bucket.requestedServiceTier.length > 128 ||
      bucket.requestedServiceTier.includes("\u0000") ||
      (bucket.computerId && bucket.computerId !== node) ||
      bucket.revision <= previous ||
      bucket.revision > response.nextRevision
    )
      throw invalid();
    const hour = timestampDate(bucket.bucketStart).getTime();
    const key = JSON.stringify([hour, bucket.provider, bucket.model, bucket.requestedServiceTier]);

    if (!Number.isFinite(hour) || hour % 3_600_000 !== 0 || keys.has(key)) throw invalid();

    if (
      !Number.isFinite(bucket.totals.reportedCostUsd) ||
      bucket.totals.reportedCostUsd < 0 ||
      bucket.totals.unknownCostReports > bucket.totals.reports ||
      bucket.totals.cachedInputTokens + bucket.totals.cacheWriteInputTokens > bucket.totals.inputTokens ||
      bucket.totals.reasoningOutputTokens > bucket.totals.outputTokens
    )
      throw invalid();
    keys.add(key);
    previous = bucket.revision;
  }

  if (response.nextRevision !== previous) throw invalid();

  return since;
}
