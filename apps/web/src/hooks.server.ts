import { building } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { documentAttributes } from "#lib/features/settings/appearance.ts";
import { shellAppearance } from "#lib/server/shell-appearance.ts";
import { requireServiceToken } from "#lib/server/gateway.ts";

export const init: ServerInit = () => {
  if (!building) requireServiceToken();
};

/**
 * The SPA shell carries the gateway's appearance on <html>; client components seed from it before
 * their first paint. The short cached lookup has a deadline, including when the gateway is down.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const page = !event.isDataRequest && !event.url.pathname.startsWith("/api/");
  const appearance = page && event.url.pathname !== "/desktop" ? shellAppearance() : undefined;
  return resolve(event, {
    transformPageChunk: async ({ html }) => {
      const attributes = documentAttributes(await appearance);
      return html.replace(/%canopy\.\w+%/g, (placeholder) => attributes[placeholder] ?? "");
    },
  });
};
