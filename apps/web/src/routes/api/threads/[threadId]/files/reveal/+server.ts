import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { isLocalDesktop } from "#lib/server/desktop-origin.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  itemId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});

/** Only the authenticated desktop BFF in local mode may ask its bundled worker to reveal a file. */
export const POST: RequestHandler = async ({ params, request }) => {
  if (!isLocalDesktop()) error(403, "Reveal files from the Canopy desktop app on this computer.");
  const { path, itemId } = await readBody(request, Body);
  await call((api) => api.revealThreadFile({ threadId: params.threadId, path, itemId }, { timeoutMs: 35_000 }));

  return json({});
};
