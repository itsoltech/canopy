import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * Gallery of the Bots components with made-up data, for development only. `import.meta.env.DEV` is
 * replaced by a literal while the module is transformed, so in production builds the import below is
 * dead code: the gallery and its fixtures are not bundled and the route answers 404.
 */
export const load: PageLoad = import.meta.env.DEV
  ? async () => ({ Gallery: (await import("#lib/features/bots/gallery/BotsGallery.svelte")).default })
  : () => error(404, "Not found");
