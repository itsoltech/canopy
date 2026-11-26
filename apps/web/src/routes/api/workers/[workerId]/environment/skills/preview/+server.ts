import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.PreviewWorkerSkillRequestSchema);
  body.workerId = params.workerId;

  const result = await call((api) => api.previewWorkerSkill(body, { signal: request.signal }));

  return json(encode(ui.PreviewWorkerSkillResponseSchema, result), { headers: { "cache-control": "no-store" } });
};
