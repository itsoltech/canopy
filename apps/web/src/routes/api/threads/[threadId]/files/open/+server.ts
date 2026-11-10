import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) });

/** Opens a thread's file in its default app on the worker's computer. */
export const POST: RequestHandler = async ({ params, request }) => {
  const { path } = await readBody(request, Body);
  await call((api) => api.openThreadFile({ threadId: params.threadId, path }, { timeoutMs: 35_000 }));

  return json({});
};
