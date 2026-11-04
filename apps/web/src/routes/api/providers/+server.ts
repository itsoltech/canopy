import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Every global provider instance with its state per worker (secrets only as "set"). */
export const GET: RequestHandler = async () =>
  json(encode(ui.ListProviderInstancesResponseSchema, await call((api) => api.listProviderInstances({}))));
