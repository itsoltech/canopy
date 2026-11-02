import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { PageServerLoad } from "./$types";

/** Every global provider instance (no secret values) and the workers' full model catalogs. */
export const load: PageServerLoad = async () => {
  const [instances, models] = await Promise.all([call((api) => api.listProviderInstances({})), call((api) => api.listModels({ unfiltered: true }))]);
  return { instances: encode(ui.ListProviderInstancesResponseSchema, instances), models: encode(ui.ListModelsResponseSchema, models) };
};
