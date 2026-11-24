import { building, dev } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { parseDeviceAppearance } from "@canopy/domain";
import { appearanceCookie, documentAttributes } from "#lib/features/settings/appearance.ts";
import { requireServiceToken } from "#lib/server/gateway.ts";
import { desktopWebOrigin, trustedDesktopRequest } from "#lib/server/desktop-origin.ts";
import { trustedDevRequest } from "#lib/server/dev-origin.ts";
import { buildIdentity, shellIdentity } from "#lib/server/channel-identity.ts";

export const init: ServerInit = () => {
  if (!building) requireServiceToken();
};

export const handle: Handle = async ({ event, resolve }) => {
  const desktopOrigin = desktopWebOrigin();

  if (!trustedDesktopRequest(event.request, event.url, desktopOrigin))
    return new Response("Untrusted desktop origin", { status: 403 });

  if (dev && !desktopOrigin && !trustedDevRequest(event.request, event.url))
    return new Response("Untrusted web origin", { status: 403, headers: { "cache-control": "no-store" } });
  const page = !event.isDataRequest && !event.url.pathname.startsWith("/api/");
  const appearance = page ? parseDeviceAppearance(event.cookies.get(appearanceCookie) ?? null) : undefined;
  const identity = page && !building ? shellIdentity() : undefined;

  const response = await resolve(event, {
    transformPageChunk: async ({ html }) => {
      const attributes = documentAttributes(appearance);
      const channel = (await identity) ?? buildIdentity;
      attributes.set("%canopy.client%", desktopOrigin ? "desktop" : "web");
      attributes.set("%canopy.applicationName%", channel.displayName);
      attributes.set("%canopy.channelAssets%", channel.assets);

      return html.replace(/%canopy\.\w+%/g, (placeholder) => attributes.get(placeholder) ?? "");
    },
  });

  if (event.url.pathname.startsWith("/api/") && response.status >= 400) {
    response.headers.set("cache-control", "no-store");
    response.headers.delete("etag");
  }

  if (page && response.headers.get("content-type")?.startsWith("text/html"))
    response.headers.set("cache-control", "private, no-store");

  return response;
};
