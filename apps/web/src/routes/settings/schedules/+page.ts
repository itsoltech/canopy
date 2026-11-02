import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => ({ schedules: await loadJson(fetch, "/api/schedules?includeFinished=true") });
