import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { EntityId, readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preview"), turnId: EntityId }),
  Schema.Struct({
    action: Schema.Literal("rewind"),
    turnId: EntityId,
    clientRequestId: EntityId,
    restoreFiles: Schema.Boolean,
    stopRunning: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literals(["read", "restore"]), rewindId: EntityId }),
]);

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  const threadId = params.threadId;

  if (body.action === "preview")
    return json(
      encode(ui.ThreadRewindPreviewSchema, await call((api) => api.prepareThreadRewind({ threadId, ...body }))),
    );

  const result = await call((api) => {
    if (body.action === "rewind") return api.rewindThread({ threadId, ...body });

    return body.action === "restore"
      ? api.restoreThreadRewind({ threadId, rewindId: body.rewindId })
      : api.getThreadRewind({ threadId, rewindId: body.rewindId });
  });

  return json(encode(ui.ThreadRewindResponseSchema, result));
};
