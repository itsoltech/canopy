import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "Cache-Control": "no-store" };

export const GET: RequestHandler = async () =>
  json(encode(ui.AgentEnvironmentSnapshotSchema, await call((api) => api.getAgentEnvironment({}))), { headers });

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SaveInstructionDocumentRequestSchema);

  return json(encode(ui.AgentEnvironmentSnapshotSchema, await call((api) => api.saveInstructionDocument(body))), {
    headers,
  });
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.DeleteInstructionDocumentRequestSchema);

  return json(encode(ui.AgentEnvironmentSnapshotSchema, await call((api) => api.deleteInstructionDocument(body))), {
    headers,
  });
};
