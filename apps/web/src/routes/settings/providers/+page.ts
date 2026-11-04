import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  const [instances, models] = await Promise.all([
    loadJson(fetch, "/api/providers"),
    loadJson(fetch, "/api/models?unfiltered=1"),
  ]);

  return { instances, models };
};
