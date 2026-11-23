import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.SetProjectColorRequestSchema);
  await call((api) => api.setProjectColor({ ...body, projectId: params.projectId }));

  return json({});
};
