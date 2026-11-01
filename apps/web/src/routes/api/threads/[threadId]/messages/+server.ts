import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  clientRequestId: Schema.String.check(Schema.isUUID()),
  // This turn only; missing or "" = the thread's defaults.
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  const response = await call((api) => api.sendMessage({ threadId: params.threadId, ...body }));
  return json(encode(ui.SendMessageResponseSchema, response));
};
