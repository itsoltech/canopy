import { json } from "@sveltejs/kit";
import { gatewayCompatibility } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(await gatewayCompatibility(), { headers: { "cache-control": "no-store" } });
