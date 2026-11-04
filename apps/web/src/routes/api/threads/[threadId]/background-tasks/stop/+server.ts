import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ itemId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)) });

/** Stops a running background task (StopBackgroundTask); the live stream brings its end. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { itemId } = await readBody(request, Body);
  await call((api) => api.stopBackgroundTask({ threadId: params.threadId, itemId }, { timeoutMs: 70_000 }));

  return json({});
};
