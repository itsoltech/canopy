import { loadJson } from "#lib/shared/load-json.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const response = (await loadJson(fetch, `/api/threads/${encodeURIComponent(params.threadId)}`)) as {
    thread?: unknown;
  };

  return { thread: response.thread ?? null };
};
