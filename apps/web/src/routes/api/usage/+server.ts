import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const days = Number(url.searchParams.get("days") ?? "30");

  if (![1, 7, 30, 90].includes(days)) error(400, "Choose today, 7, 30 or 90 days.");

  const stats = await call((api) =>
    api.getUsageStats({
      days,
      provider: url.searchParams.get("provider") ?? "",
      computerId: url.searchParams.get("computerId") ?? "",
      activityKind: url.searchParams.get("activityKind") ?? "",
      botId: url.searchParams.get("botId") ?? "",
      ...(url.searchParams.has("requestedServiceTier") && {
        requestedServiceTier: url.searchParams.get("requestedServiceTier") ?? "",
      }),
    }),
  );

  return json(encode(ui.GetUsageStatsResponseSchema, stats), { headers: { "cache-control": "no-store" } });
};
