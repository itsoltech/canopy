import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const threadId = params.threadId;
  const key = `GetThreadPanel:${threadId}`;

  return json(
    encode(
      ui.ThreadPanelSchema,
      await call((api) => bffSession().reads.read(key, ui.ThreadPanelSchema, () => api.getThreadPanel({ threadId }))),
    ),
  );
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const grant = await readMessage(request, ui.SetThreadConnectorGrantRequestSchema);

  const value = await call(async (api) => {
    const session = bffSession();
    const panel = await api.setThreadConnectorGrant({ ...grant, threadId: params.threadId });
    session.reads.invalidate(`GetThreadPanel:${params.threadId}`);

    return panel;
  });

  return json(encode(ui.ThreadPanelSchema, value));
};
