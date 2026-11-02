import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ turnId: Schema.String.check(Schema.isUUID()) });

/** "Fork from here": a new main thread with this thread's history up to and including the ended turn (CreateThread.fork_at_turn_id). */
export const POST: RequestHandler = async ({ request, params }) => {
  const { turnId } = await readBody(request, Body);
  return json(encode(ui.CreateThreadResponseSchema, await call((api) => api.createThread({ forkThreadId: params.threadId, forkAtTurnId: turnId }))));
};
