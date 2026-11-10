import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

/** Opens the thread's directory in the file manager of its worker's computer. */
export const POST: RequestHandler = async ({ params }) => {
  await call((api) => api.revealThreadDirectory({ threadId: params.threadId }, { timeoutMs: 25_000 }));

  return json({});
};
