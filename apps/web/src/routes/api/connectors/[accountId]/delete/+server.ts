import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params }) => {
  await call((api) => api.deleteConnectorAccount({ accountId: params.accountId }, { timeoutMs: 50_000 }));

  return json({});
};
