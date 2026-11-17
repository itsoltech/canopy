import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.deleteBotMessengerRoute({ routeId: params.routeId }));

  return json({});
};
