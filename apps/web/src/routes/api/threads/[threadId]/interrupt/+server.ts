import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params }) => {
  await readBody(request, Schema.Struct({}));
  await call((api) => api.interruptThread({ threadId: params.threadId }));
  return json({});
};
