import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:connectors");

  return { connections: await loadJson(fetch, "/api/connectors") };
};
