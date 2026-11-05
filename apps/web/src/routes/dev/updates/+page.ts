import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** The updates center with fixture data, for development only (dead code in production builds, like /dev/bots). */
export const load: PageLoad = import.meta.env.DEV
  ? async () => ({ Gallery: (await import("#lib/features/workers/dev/UpdatesGallery.svelte")).default })
  : () => error(404, "Not found");
