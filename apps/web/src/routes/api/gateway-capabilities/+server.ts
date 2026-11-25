import { json } from "@sveltejs/kit";
import { gatewayCompatibility, clientPreferencesScope } from "#lib/server/gateway.ts";
import { desktopBffMode } from "#lib/server/desktop-origin.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const scope = clientPreferencesScope();
  const mode = desktopBffMode();
  const localDesktop = mode === "local";
  const compatibility = await gatewayCompatibility();

  return json(
    {
      ...compatibility,
      clientPreferencesScope: scope,
      localDesktop,
      remoteDesktop: mode === "remote",
      localPushRelaySettings: localDesktop && compatibility.pushRelaySettings === true,
    },
    { headers: { "cache-control": "no-store" } },
  );
};
