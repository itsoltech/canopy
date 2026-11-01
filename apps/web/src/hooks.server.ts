import { building } from "$app/env";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { documentAttributes } from "#lib/features/settings/appearance.ts";
import { loadSettings } from "#lib/features/settings/server/settings.ts";
import { requireServiceToken } from "#lib/server/gateway.ts";

export const init: ServerInit = () => {
  if (!building) requireServiceToken();
};

/**
 * Pages are rendered with the user's appearance (scheme, accent, chat width) on `<html>`, so there is
 * no flash before the app starts; the root layout reuses the settings loaded here.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const page = !event.isDataRequest && !event.url.pathname.startsWith("/api/");
  // Started here, awaited by the root layout load alongside the overview.
  const settings = page ? loadSettings() : undefined;
  if (settings) event.locals.settings = settings;
  return resolve(event, {
    transformPageChunk: async ({ html }) => {
      const attributes = documentAttributes((await settings)?.user?.appearance);
      return html.replace(/%oa\.\w+%/g, (placeholder) => attributes[placeholder] ?? "");
    },
  });
};
