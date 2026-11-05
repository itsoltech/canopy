import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:connectors");
  const [connections, bots] = await Promise.all([loadJson(fetch, "/api/connectors"), loadJson(fetch, "/api/bots")]);

  return { connections, bots };
};
