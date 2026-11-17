import { ui } from "@canopy/contracts";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { decode } from "#lib/shared/wire.ts";
import { requestJson } from "#lib/shared/http.ts";
import { dayLabel, providerName, speedName, type UsageAmounts, type UsageData } from "./format.ts";

function amounts(totals: ui.UsageTotals | undefined): UsageAmounts {
  return {
    input: totals?.inputTokens ?? 0n,
    output: totals?.outputTokens ?? 0n,
    cacheRead: totals?.cachedInputTokens ?? 0n,
    cacheWrite: totals?.cacheWriteInputTokens ?? 0n,
    reasoning: totals?.reasoningOutputTokens ?? 0n,
    cost: totals?.reportedCostUsd ?? 0,
    reports: totals?.reports ?? 0n,
    costReports: (totals?.reports ?? 0n) - (totals?.unknownCostReports ?? 0n),
  };
}

const iso = (timestamp: Timestamp | undefined) => (timestamp ? timestampDate(timestamp).toISOString() : "");

export async function loadUsage(
  days: string,
  provider: string,
  computerId: string,
  requestedServiceTier: string | undefined,
  signal: AbortSignal,
): Promise<UsageData> {
  const query = new URLSearchParams({ days, provider, computerId });

  if (requestedServiceTier !== undefined) query.set("requestedServiceTier", requestedServiceTier);

  const response = decode(
    ui.GetUsageStatsResponseSchema,
    await requestJson("GET", `/api/usage?${query}`, undefined, 40_000, signal),
  );

  return {
    totals: amounts(response.totals),
    providers: response.providers.map((row) => ({
      key: row.key,
      label: providerName(row.key),
      amounts: amounts(row.totals),
    })),
    models: response.models.map((row) => ({
      key: row.key,
      label: row.key || "Unspecified model",
      amounts: amounts(row.totals),
    })),
    speeds: response.speeds.map((row) => ({
      key: row.key,
      label: speedName(row.key),
      amounts: amounts(row.totals),
    })),
    days: response.days
      .filter((row) => row.day)
      .map((row) => {
        const key = iso(row.day).slice(0, 10);

        return {
          key,
          label: dayLabel(key, true),
          amounts: amounts(row.totals),
          providers: row.providers.map((provider) => ({
            key: provider.key,
            label: providerName(provider.key),
            amounts: amounts(provider.totals),
          })),
        };
      })
      .toSorted((a, b) => a.key.localeCompare(b.key)),
    computers: response.sources.map((source) => ({
      id: source.computerId,
      name: source.name || (source.local ? "This computer" : "Unnamed computer"),
      available: source.online,
      status: source.status || (source.online ? "ready" : "offline"),
      trackingSince: iso(source.trackingSince),
      updatedAt: iso(source.updatedAt),
    })),
    partial: response.partial,
  };
}
