import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * The workers' last reported model catalogs (`?workerId=` for one), for resynchronising after a gap; `?unfiltered=1`
 * without the instances' model choices (provider settings).
 */
export const GET: RequestHandler = async ({ url }) =>
  json(
    encode(
      ui.ListModelsResponseSchema,
      await call((api) => api.listModels({ workerId: url.searchParams.get("workerId") ?? "", unfiltered: url.searchParams.get("unfiltered") === "1" })),
    ),
  );

const Refresh = Schema.Struct({ workerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) });

/** Lists the worker's models again (it must be online; 503 otherwise). */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readBody(request, Refresh);
  return json(encode(ui.ListModelsResponseSchema, await call((api) => api.listModels({ workerId: body.workerId, refresh: true }))));
};
