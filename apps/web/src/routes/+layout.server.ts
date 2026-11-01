import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => ({
  overview: encode(ui.GetOverviewResponseSchema, await call((api) => api.getOverview({}))),
});
