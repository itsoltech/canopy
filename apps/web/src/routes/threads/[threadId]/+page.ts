import { objectOf } from "#lib/shared/json.ts";
import { loadJson } from "#lib/shared/load-json.ts";
import { threadCache } from "#lib/features/threads/thread-cache.ts";
import { encode } from "#lib/shared/wire.ts";
import { ui } from "@canopy/contracts";
import type { PageLoad } from "./$types";

export const load = (async ({ fetch, params }) => {
  const cached = (await threadCache.load(params.threadId))?.thread;

  if (cached) return { thread: encode(ui.ThreadSchema, cached) };
  const response = objectOf(await loadJson(fetch, `/api/threads/${encodeURIComponent(params.threadId)}`));

  return { thread: response["thread"] ?? null };
}) satisfies PageLoad;
