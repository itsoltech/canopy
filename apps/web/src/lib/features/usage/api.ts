import { ui } from "@canopy/contracts";
import { usageReport, type UsageData } from "@canopy/domain/usage-report";
import { decode } from "#lib/shared/wire.ts";
import { requestJson } from "#lib/shared/http.ts";
import { subscribeTime } from "#lib/shared/ticker.ts";

interface UsageFilters {
  days: string;
  provider?: string;
  computerId?: string;
  requestedServiceTier?: string | undefined;
  activityKind?: string;
  botId?: string;
}

export function subscribeUsageRefresh(refresh: () => void): () => void {
  return subscribeTime(() => {
    if (!document.hidden) refresh();
  }, 10_000);
}

export async function loadUsage(filters: UsageFilters, signal: AbortSignal): Promise<UsageData> {
  const { days, provider = "", computerId = "", requestedServiceTier, activityKind, botId } = filters;
  const query = new URLSearchParams({ days, provider, computerId });

  if (requestedServiceTier !== undefined) query.set("requestedServiceTier", requestedServiceTier);

  if (activityKind) query.set("activityKind", activityKind);

  if (botId) query.set("botId", botId);

  const response = decode(
    ui.GetUsageStatsResponseSchema,
    await requestJson("GET", `/api/usage?${query}`, undefined, 40_000, signal),
  );

  return usageReport(response);
}
