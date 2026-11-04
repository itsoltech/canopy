import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  action: Schema.Literals(["archive", "unarchive", "delete", "restore", "read", "unread"]),
});

export const POST: RequestHandler = async ({ request, params }) => {
  const { action } = await readBody(request, Body);
  const threadId = params.threadId;

  if (action === "delete")
    return json(encode(ui.DeleteThreadResponseSchema, await call((api) => api.deleteThread({ threadId }))));

  if (action === "restore")
    return json(encode(ui.ListThreadsResponseSchema, await call((api) => api.restoreThread({ threadId }))));

  if (action === "read" || action === "unread")
    return json(
      encode(
        ui.MarkThreadSeenResponseSchema,
        await call((api) => api.setThreadRead({ threadId, unread: action === "unread" })),
      ),
    );

  return json(
    encode(
      ui.GetThreadResponseSchema,
      await call((api) => api.setThreadArchived({ threadId, archived: action === "archive" })),
    ),
  );
};
