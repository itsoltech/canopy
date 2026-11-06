import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.deleteBotApprovalRule({ botId: params.botId, ruleId: params.ruleId }));

  return json({});
};
