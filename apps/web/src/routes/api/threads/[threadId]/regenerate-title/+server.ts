import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params }) => {
  await call((api) => api.regenerateTitle({ threadId: params.threadId }));

  return json({});
};
