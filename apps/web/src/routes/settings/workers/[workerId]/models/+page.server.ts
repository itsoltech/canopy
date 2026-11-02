import { error } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { PageServerLoad } from "./$types";

/** A profile's model selection: its settings and the worker's full catalog (not filtered by any selection). */
export const load: PageServerLoad = async ({ params, url, depends }) => {
  depends("app:profiles");
  const profileId = url.searchParams.get("profile") ?? "";
  const provider = url.searchParams.get("provider");
  if (!profileId || (provider !== "claude" && provider !== "codex")) error(400, "Choose a profile and a provider (claude or codex)");
  const [profiles, models] = await Promise.all([
    call((api) => api.listProviderProfiles({ workerId: params.workerId })),
    call((api) => api.listModels({ workerId: params.workerId, unfiltered: true })),
  ]);
  if (!profiles.profiles.some((p) => p.id === profileId)) error(404, "Profile not found");
  return {
    profileId,
    provider,
    profiles: encode(ui.ListProviderProfilesResponseSchema, profiles),
    models: encode(ui.ListModelsResponseSchema, models),
  };
};
