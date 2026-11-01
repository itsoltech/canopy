import { isHttpError } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { LayoutServerLoad } from "./$types";

/**
 * The overview and every thread (an empty project lists them all) seed the app shell (thread inbox).
 * When the gateway is down the shell still renders (with an "unavailable" state) and the live stream
 * fills it in once the gateway answers.
 */
export const load: LayoutServerLoad = async () => {
  try {
    const [overview, threads] = await Promise.all([call((api) => api.getOverview({})), call((api) => api.listThreads({ projectId: "" }))]);
    return { overview: encode(ui.GetOverviewResponseSchema, overview), threads: encode(ui.ListThreadsResponseSchema, threads) };
  } catch (cause) {
    if (isHttpError(cause) && cause.status >= 500) return { overview: null, threads: null };
    throw cause;
  }
};
