import { json } from "@sveltejs/kit";
import { gatewayCompatibility, clientPreferencesScope } from "#lib/server/gateway.ts";
import { isLocalDesktop } from "#lib/server/desktop-origin.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const scope = clientPreferencesScope();
  const localDesktop = isLocalDesktop();
  const compatibility = await gatewayCompatibility();

  return json(
    {
      ...compatibility,
      clientPreferencesScope: scope,
      localDesktop,
      localPushRelaySettings: localDesktop && compatibility.pushRelaySettings === true,
    },
    { headers: { "cache-control": "no-store" } },
  );
};
