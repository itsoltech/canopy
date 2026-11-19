import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { type computerLink as link, ui } from "@canopy/contracts";
import { isUuid } from "@canopy/domain/humanize";
import { Code, ConnectError } from "@connectrpc/connect";
import { readActivityKey } from "../usage/activity.ts";
import { addTotals, COST_FIELDS, COUNT_FIELDS, normalizeUsageTotals } from "../usage/totals.ts";

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

    const totals = validatedTotals(bucket.totals);
    validateActivities(bucket.activities, totals);
    keys.add(key);
    previous = bucket.revision;
  }

  if (response.nextRevision !== previous) throw invalid();

  return since;
}

function validatedTotals(input: ui.UsageTotals) {
  if (
    COUNT_FIELDS.some((field) => input[field] < 0n) ||
    !Number.isFinite(input.reportedCostUsd) ||
    input.reportedCostUsd < 0 ||
    input.unknownCostReports > input.reports ||
    input.cachedInputTokens + input.cacheWriteInputTokens > input.inputTokens ||
    input.reasoningOutputTokens > input.outputTokens
  )
    throw invalid();
  const totals = normalizeUsageTotals(input);

  if (
    !Number.isFinite(totals.estimatedCostUsd) ||
    totals.estimatedCostUsd < 0 ||
    !Number.isFinite(totals.effectiveCostUsd) ||
    totals.effectiveCostUsd < 0 ||
    totals.unknownEstimatedCostReports > totals.reports ||
    totals.unknownEffectiveCostReports + totals.effectiveReportedCostReports + totals.effectiveEstimatedCostReports !==
      totals.reports ||
    totals.effectiveReportedCostReports > totals.reports - totals.unknownCostReports ||
    totals.effectiveEstimatedCostReports > totals.reports - totals.unknownEstimatedCostReports ||
    (totals.unknownEffectiveCostReports === totals.reports && totals.effectiveCostUsd !== 0)
  )
    throw invalid();

  return totals;
}

function validateActivities(parts: ui.UsageActivityBucket[], totals: ui.UsageTotals) {
  if (!parts.length) return;
  const sum = create(ui.UsageTotalsSchema);
  const keys = new Set<string>();

  for (const part of parts) {
    const activity = readActivityKey(part.key);

    if (!activity || !part.totals?.reports) throw invalid();
    const key = activity.botId || activity.kind;

    if (
      keys.has(key) ||
      (part.botName && !activity.botId) ||
      part.botName.length > 160 ||
      part.botName.includes("\u0000")
    )
      throw invalid();
    keys.add(key);
    const amounts = validatedTotals(part.totals);
    validateWorkers(part.workers, amounts);
    addTotals(sum, amounts);
  }

  validateSum(sum, totals);
}

function validateWorkers(workers: ui.UsageWorkerBreakdown[], totals: ui.UsageTotals) {
  if (!workers.length) return;
  const sum = create(ui.UsageTotalsSchema);
  const ids = new Set<string>();

  for (const worker of workers) {
    const id = worker.workerId.toLowerCase();

    if (
      (id ? id.length !== 36 || !isUuid(id) : Boolean(worker.name)) ||
      ids.has(id) ||
      [...worker.name].length > 200 ||
      worker.name.includes("\u0000") ||
      !worker.totals?.reports
    )
      throw invalid();
    ids.add(id);
    addTotals(sum, validatedTotals(worker.totals));
  }

  validateSum(sum, totals);
}

function validateSum(sum: ui.UsageTotals, totals: ui.UsageTotals) {
  if (COUNT_FIELDS.some((field) => sum[field] !== totals[field])) throw invalid();

  if (
    COST_FIELDS.some(
      (field) =>
        !Number.isFinite(sum[field]) || Math.abs(sum[field] - totals[field]) > Math.max(1, totals[field]) * 1e-9,
    )
  )
    throw invalid();
}
