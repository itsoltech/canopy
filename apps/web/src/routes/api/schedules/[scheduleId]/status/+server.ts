import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ status: Schema.Literals(["active", "paused", "cancelled"]) });

/** Pause, resume (active) or cancel. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { status } = await readBody(request, Body);
  const response = await call((api) => api.setScheduleStatus({ scheduleId: params.scheduleId, status }));

  return json(encode(ui.SetScheduleStatusResponseSchema, response));
};
