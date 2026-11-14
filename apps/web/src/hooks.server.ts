import { building } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { documentAttributes } from "#lib/features/settings/appearance.ts";
import { shellAppearance } from "#lib/server/shell-appearance.ts";
import { requireServiceToken } from "#lib/server/gateway.ts";
import { desktopWebOrigin, trustedDesktopRequest } from "#lib/server/desktop-origin.ts";
import { shellIdentity } from "#lib/server/channel-identity.ts";

export const init: ServerInit = () => {
  if (!building) requireServiceToken();
};

/**
 * The SPA shell carries the gateway's appearance on <html>; client components seed from it before
 * their first paint. The short cached lookup has a deadline, including when the gateway is down.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const desktopOrigin = desktopWebOrigin();

  if (!trustedDesktopRequest(event.request, event.url, desktopOrigin))
    return new Response("Untrusted desktop origin", { status: 403 });
  const page = !event.isDataRequest && !event.url.pathname.startsWith("/api/");
  const appearance = page && event.url.pathname !== "/desktop" ? shellAppearance() : undefined;
  const identity = page && !building ? shellIdentity() : undefined;

  const response = await resolve(event, {
    transformPageChunk: async ({ html }) => {
      const attributes = documentAttributes(await appearance);
      const channel = await identity;
      attributes.set("%canopy.applicationName%", channel?.displayName ?? "Canopy");
      attributes.set("%canopy.channelAssets%", channel?.assets ?? "/channels/stable");

      return html.replace(/%canopy\.\w+%/g, (placeholder) => attributes.get(placeholder) ?? "");
    },
  });

  if (event.url.pathname.startsWith("/api/") && response.status >= 400) {
    response.headers.set("cache-control", "no-store");
    response.headers.delete("etag");
  }

  return response;
};
