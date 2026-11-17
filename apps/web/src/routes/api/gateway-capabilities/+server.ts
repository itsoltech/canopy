import { json } from "@sveltejs/kit";
import { gatewayCompatibility, clientPreferencesScope } from "#lib/server/gateway.ts";
import { isLocalDesktop } from "#lib/server/desktop-origin.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(
    {
      ...(await gatewayCompatibility()),
      clientPreferencesScope: clientPreferencesScope(),
      localDesktop: isLocalDesktop(),
    },
    { headers: { "cache-control": "no-store" } },
  );
