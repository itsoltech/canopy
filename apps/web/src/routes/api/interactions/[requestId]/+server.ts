import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  allow: Schema.optionalKey(Schema.Boolean),
  allowForSession: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
  answerJson: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100_000))),
  cancelled: Schema.optionalKey(Schema.Boolean),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  const response = await call((api) => api.answerInteraction({ requestId: params.requestId, ...body }));
  return json(encode(ui.AnswerInteractionResponseSchema, response));
};
