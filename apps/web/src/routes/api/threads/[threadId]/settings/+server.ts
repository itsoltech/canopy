import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { PermissionMode, ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

// Missing = unchanged, "" = the profile's default.
const Body = Schema.Struct({
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  // Enum key; missing = unchanged.
  permissionMode: Schema.optionalKey(Schema.Literals(["ASK", "ACCEPT_EDITS", "READ_ONLY", "FULL_AUTO", "FULL_ACCESS"])),
});

/** The thread's default model, effort and permission mode (UpdateThread), for turns without a per-message choice. */
export const POST: RequestHandler = async ({ request, params }) => {
  const { permissionMode, ...body } = await readBody(request, Body);
  const change = { ...body, ...(permissionMode && { permissionMode: PermissionMode[permissionMode] }) };

  return json(
    encode(
      ui.UpdateThreadResponseSchema,
      await call((api) => api.updateThread({ threadId: params.threadId, ...change })),
    ),
  );
};
