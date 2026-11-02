import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { PageServerLoad } from "./$types";

/** The worker's provider profiles (no secret values; the gateway answers 404 for an unknown worker). */
export const load: PageServerLoad = async ({ params, depends }) => {
  depends("app:profiles");
  const profiles = await call((api) => api.listProviderProfiles({ workerId: params.workerId }));
  return { profiles: encode(ui.ListProviderProfilesResponseSchema, profiles) };
};
