import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.UpdateScheduleRequestSchema);
  body.scheduleId = params.scheduleId;
  return json(encode(ui.UpdateScheduleResponseSchema, await call((api) => api.updateSchedule(body))));
};
