import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.SetProjectImageRequestSchema);
  await call((api) => api.setProjectImage({ ...body, projectId: params.projectId }));

  return json({});
};
