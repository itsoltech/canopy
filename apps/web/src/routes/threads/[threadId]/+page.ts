import { objectOf } from "#lib/shared/json.ts";
import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load = (async ({ fetch, params }) => {
  const response = objectOf(await loadJson(fetch, `/api/threads/${encodeURIComponent(params.threadId)}`));

  return { thread: response["thread"] ?? null };
}) satisfies PageLoad;
