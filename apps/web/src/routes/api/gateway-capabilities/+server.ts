import { json } from "@sveltejs/kit";
import { gatewayCompatibility, clientPreferencesScope } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(
    { ...(await gatewayCompatibility()), clientPreferencesScope: clientPreferencesScope() },
    { headers: { "cache-control": "no-store" } },
  );
