import { isHttpError } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { LayoutServerLoad } from "./$types";

/**
 * The overview seeds the app shell. When the gateway is down the shell still renders (with an
 * "unavailable" state) and the live stream fills it in once the gateway answers again.
 */
export const load: LayoutServerLoad = async () => {
  try {
    return { overview: encode(ui.GetOverviewResponseSchema, await call((api) => api.getOverview({}))) };
  } catch (cause) {
    if (isHttpError(cause) && cause.status >= 500) return { overview: null };
    throw cause;
  }
};
