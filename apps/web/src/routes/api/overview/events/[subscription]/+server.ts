import { error } from "@sveltejs/kit";
import { Schema } from "effect";
import { bffSession } from "#lib/server/bff-session.ts";
import { EntityId, readBody } from "#lib/server/body.ts";
import type { RequestHandler } from "./$types";

const Selection = Schema.Struct({
  heads: Schema.Array(EntityId).check(Schema.isMaxLength(32)),
  active: Schema.Union([Schema.Literal(""), EntityId]),
});

/**
 * The tab's thread selection for its open overview stream: warming and thread heads follow it in place. 404 once
 * the stream is gone; the tab's next connection opens with its current selection.
 */
export const PUT: RequestHandler = async ({ request, params }) => {
  const { heads, active } = await readBody(request, Selection);

  if (!bffSession().select(params.subscription, heads, active)) error(404, "Overview stream not found");

  return new Response(null, { status: 204 });
};
