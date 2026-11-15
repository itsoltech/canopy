import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const modelKey = (workerId: string, unfiltered: boolean) =>
  workerId || unfiltered
    ? `ListModels:${encodeURIComponent(workerId)}:${unfiltered ? "unfiltered" : "filtered"}`
    : "ListModels";

/**
 * The workers' last reported model catalogs (`?workerId=` for one), for resynchronising after a gap; `?unfiltered=1`
 * without the instances' model choices (provider settings).
 */
export const GET: RequestHandler = async ({ url }) => {
  const workerId = url.searchParams.get("workerId") ?? "";
  const unfiltered = url.searchParams.get("unfiltered") === "1";
  const key = modelKey(workerId, unfiltered);

  return json(
    encode(
      ui.ListModelsResponseSchema,
      await call((api) =>
        bffSession().reads.read(key, ui.ListModelsResponseSchema, () => api.listModels({ workerId, unfiltered })),
      ),
    ),
  );
};

const Refresh = Schema.Struct({ workerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) });

/** Lists the worker's models again (it must be online; 503 otherwise). */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readBody(request, Refresh);

  const value = await call(async (api) => {
    const session = bffSession();
    const models = await api.listModels({ workerId: body.workerId, refresh: true }, { timeoutMs: 100_000 });

    for (const workerId of ["", body.workerId])
      for (const unfiltered of [false, true]) session.reads.invalidate(modelKey(workerId, unfiltered));

    return models;
  });

  return json(encode(ui.ListModelsResponseSchema, value));
};
