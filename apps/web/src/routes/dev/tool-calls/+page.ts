import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** Gallery of tool-call views with fixture data, for development only (dead code in production builds, like /dev/bots). */
export const load: PageLoad = import.meta.env.DEV
  ? async () => ({ Gallery: (await import("#lib/features/threads/dev/ToolCallGallery.svelte")).default })
  : () => error(404, "Not found");
