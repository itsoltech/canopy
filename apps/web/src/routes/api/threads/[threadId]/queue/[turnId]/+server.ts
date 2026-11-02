import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@open-agents/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("edit"),
    text: Schema.String.check(Schema.isMaxLength(100_000)),
    expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  // delete: out of the queue; restore: its undo; steer: into the running turn now.
  Schema.Struct({ action: Schema.Literals(["delete", "restore", "steer"]) }),
]);

/** One queued message (docs/ui-api.md, "Kolejka"): edit, delete, restore or steer it. */
export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);
  const turnId = params.turnId;
  switch (body.action) {
    case "edit":
      return json(encode(ui.EditQueuedTurnResponseSchema, await call((api) => api.editQueuedTurn({ turnId, text: body.text, expectedRevision: body.expectedRevision }))));
    case "delete":
      return json(encode(ui.DeleteQueuedTurnResponseSchema, await call((api) => api.deleteQueuedTurn({ turnId }))));
    case "restore":
      return json(encode(ui.RestoreQueuedTurnResponseSchema, await call((api) => api.restoreQueuedTurn({ turnId }))));
    case "steer":
      return json(encode(ui.SteerQueuedTurnResponseSchema, await call((api) => api.steerQueuedTurn({ turnId }))));
  }
};
