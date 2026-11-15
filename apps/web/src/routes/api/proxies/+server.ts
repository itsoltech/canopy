import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { bffSession } from "#lib/server/bff-session.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () =>
  json(
    encode(
      ui.ListProxiesResponseSchema,
      await call((api) =>
        bffSession().reads.read("ListProxies", ui.ListProxiesResponseSchema, () => api.listProxies({})),
      ),
    ),
  );
