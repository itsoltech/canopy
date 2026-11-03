import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32768))),
  decline: Schema.optionalKey(Schema.Boolean),
  revoke: Schema.optionalKey(Schema.Boolean),
});

/** Avoid call()/failWith(): generic transport causes can hold input. */
export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readBody(request, Body);
    const api = gateway();
    const response = body.revoke
      ? await api.revokeThreadSecret({ requestId: params.requestId })
      : await api.answerThreadSecret({ requestId: params.requestId, value: body.value ?? "", decline: body.decline ?? false });
    return json(encode(ui.ThreadSecretResponseSchema, response), { headers: { "cache-control": "no-store" } });
  } catch { error(400, "Could not update the secret. Try again."); }
};
