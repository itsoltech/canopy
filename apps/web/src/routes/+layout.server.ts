import { isHttpError } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { loadSettings } from "#lib/features/settings/server/settings.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { LayoutServerLoad } from "./$types";

/**
 * The overview, every thread (an empty project lists them all), the settings and the workers' model
 * catalogs seed the app shell (a missing catalog only leaves the pickers on their fallbacks).
 * When the gateway is down the shell still renders (with an "unavailable" state) and the live stream
 * fills it in once the gateway answers.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  // A page request already asked for the settings in `handle`.
  const pending = locals.settings ?? loadSettings();
  const settings = async () => {
    const value = await pending;
    return value ? encode(ui.GetSettingsResponseSchema, value) : null;
  };
  try {
    const models = call((api) => api.listModels({})).then(
      (response) => encode(ui.ListModelsResponseSchema, response),
      () => null,
    );
    const [overview, threads, encoded] = await Promise.all([call((api) => api.getOverview({})), call((api) => api.listThreads({ projectId: "" })), settings()]);
    return { overview: encode(ui.GetOverviewResponseSchema, overview), threads: encode(ui.ListThreadsResponseSchema, threads), settings: encoded, models: await models };
  } catch (cause) {
    if (isHttpError(cause) && cause.status >= 500) return { overview: null, threads: null, settings: await settings(), models: null };
    throw cause;
  }
};
