import { json } from "@sveltejs/kit";
import { gatewayCompatibility, clientPreferencesScope, hasGatewayServiceAccess } from "#lib/server/gateway.ts";
import { isLocalDesktop } from "#lib/server/desktop-origin.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const compatibility = await gatewayCompatibility();
  const localDesktop = isLocalDesktop();
  const pushRelaySettings = hasGatewayServiceAccess() ? compatibility.pushRelaySettings : false;

  return json(
    {
      ...compatibility,
      clientPreferencesScope: clientPreferencesScope(),
      localDesktop,
      pushRelaySettings,
      localPushRelaySettings: localDesktop && pushRelaySettings === true,
    },
    { headers: { "cache-control": "no-store" } },
  );
};
