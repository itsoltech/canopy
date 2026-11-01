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
  // queue (default): the next turn; steer: into the running turn (queued when none runs).
  delivery: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const { delivery, ...body } = await readBody(request, Body);
  const response = await call((api) =>
    api.sendMessage({ threadId: params.threadId, ...body, delivery: delivery === "steer" ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE }),
  );
  return json(encode(ui.SendMessageResponseSchema, response));
};
