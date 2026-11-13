import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  afterThreadId: Schema.String,
  beforeThreadId: Schema.String,
  withinProject: Schema.Boolean,
});

export const POST: RequestHandler = async ({ request, params }) => {
  const position = await readBody(request, Body);

  return json(
    encode(
      ui.GetThreadResponseSchema,
      await call((api) =>
        api.reorderThread({
          threadId: params.threadId,
          ...position,
        }),
      ),
    ),
  );
};
