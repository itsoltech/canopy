import { redirect } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { objectOf } from "#lib/shared/json.ts";
import { loadJson } from "#lib/shared/load-json.ts";
import { decode } from "#lib/shared/wire.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params }) => {
  const response = objectOf(await loadJson(fetch, `/api/threads/${encodeURIComponent(params.threadId)}`));
  const thread = decode(ui.ThreadSchema, response["thread"]);

  // Side threads share a two-level tree, including when this address is opened directly.
  if (thread.parentThreadId) redirect(307, `/threads/${encodeURIComponent(thread.parentThreadId)}/new-side-thread`);

  return { thread: response["thread"] };
};
