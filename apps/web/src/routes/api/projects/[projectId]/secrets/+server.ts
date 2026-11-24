import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Names and update times only: the gateway never returns a project secret's value. */
export const GET: RequestHandler = async ({ params }) => {
  const response = await call((api) => api.listProjectSecrets({ projectId: params.projectId }));

  return json(encode(ui.ListProjectSecretsResponseSchema, response), { headers: { "cache-control": "no-store" } });
};
