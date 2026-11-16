import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { PermissionMode, ui } from "@canopy/contracts";
import { EntityId, readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  turnId: EntityId,
  permissionMode: Schema.Literals(["ASK", "ACCEPT_EDITS", "READ_ONLY", "FULL_AUTO", "FULL_ACCESS"]),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const { turnId, permissionMode } = await readBody(request, Body);

  return json(
    encode(
      ui.UpdateTurnPermissionsResponseSchema,
      await call((api) =>
        api.updateTurnPermissions({
          threadId: params.threadId,
          turnId,
          permissionMode: PermissionMode[permissionMode],
        }),
      ),
    ),
  );
};
