import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.WorkerEnvironmentResponseSchema,
      await call((api) => api.getWorkerEnvironment({ workerId: params.workerId })),
    ),
  );

export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.SetWorkerEnvironmentOverrideRequestSchema);
  body.workerId = params.workerId;

  return json(encode(ui.WorkerEnvironmentResponseSchema, await call((api) => api.setWorkerEnvironmentOverride(body))));
};
