import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { isLocalDesktop } from "#lib/server/desktop-origin.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) });

/** Opens a file on the desktop where this request originated. */
export const POST: RequestHandler = async ({ params, request }) => {
  const { path } = await readBody(request, Body);

  if (!isLocalDesktop()) error(403, "Open files from the Canopy desktop app on this computer.");
  await call((api) => api.openThreadFile({ threadId: params.threadId, path }, { timeoutMs: 35_000 }));

  return json({});
};
