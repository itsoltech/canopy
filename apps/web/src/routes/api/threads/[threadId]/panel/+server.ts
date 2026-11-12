import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(encode(ui.ThreadPanelSchema, await call((api) => api.getThreadPanel({ threadId: params.threadId }))));

export const PUT: RequestHandler = async ({ params, request }) => {
  const grant = await readMessage(request, ui.SetThreadConnectorGrantRequestSchema);

  return json(
    encode(
      ui.ThreadPanelSchema,
      await call((api) => api.setThreadConnectorGrant({ ...grant, threadId: params.threadId })),
    ),
  );
};
