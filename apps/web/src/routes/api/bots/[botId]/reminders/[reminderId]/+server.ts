import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.cancelBotReminder({ botId: params.botId, reminderId: params.reminderId }));

  return json({});
};
