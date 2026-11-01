import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

// Missing = unchanged, "" = the profile's default.
const Body = Schema.Struct({
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
});

/** The thread's default model and effort (UpdateThread), for turns without a per-message choice. */
export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  return json(encode(ui.UpdateThreadResponseSchema, await call((api) => api.updateThread({ threadId: params.threadId, ...body }))));
};
