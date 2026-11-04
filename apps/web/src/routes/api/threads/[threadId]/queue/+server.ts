import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { EntityId, readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  // The queued turns in their new order (docs/ui-api.md, "Kolejka").
  turnIds: Schema.Array(EntityId).check(Schema.isMaxLength(500)),
});

/** New order of the thread's queue; a turn that already started is a 409 with the reason. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { turnIds } = await readBody(request, Body);
  const response = await call((api) => api.reorderQueuedTurns({ threadId: params.threadId, turnIds: [...turnIds] }));
  return json(encode(ui.ReorderQueuedTurnsResponseSchema, response));
};
