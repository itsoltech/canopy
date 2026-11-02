import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { PermissionMode, ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  // Empty only with attachments (the gateway checks).
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  clientRequestId: Schema.String.check(Schema.isUUID()),
  // This turn only; missing or "" = the thread's defaults.
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  // This turn's permission mode (enum key); missing = the thread's default.
  permissionMode: Schema.optionalKey(Schema.Literals(["ASK", "ACCEPT_EDITS", "READ_ONLY", "FULL_AUTO"])),
  // queue (default): the next turn; steer: into the running turn (queued when none runs).
  delivery: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  // Uploaded attachments (api/attachments); a message with attachments is always queued.
  attachmentIds: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isUUID())).check(Schema.isMaxLength(50))),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const { delivery, permissionMode, attachmentIds, ...body } = await readBody(request, Body);
  const response = await call((api) =>
    api.sendMessage({
      threadId: params.threadId,
      ...body,
      attachmentIds: [...(attachmentIds ?? [])],
      ...(permissionMode && { permissionMode: PermissionMode[permissionMode] }),
      delivery: delivery === "steer" ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE,
    }),
  );
  return json(encode(ui.SendMessageResponseSchema, response));
};
