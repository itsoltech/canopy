import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => ({ proxies: await loadJson(fetch, "/api/proxies") });
