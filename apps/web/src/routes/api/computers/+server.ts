import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };
export const GET: RequestHandler = async () => json(encode(ui.ComputersSnapshotSchema, await call((api) => api.getComputers({}))), { headers });
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.LinkComputerRequestSchema);
  return json(encode(ui.ComputersSnapshotSchema, await call((api) => api.linkComputer(body, { timeoutMs: 20_000 }))), { headers });
};
export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ComputerOperationRequestSchema);
  return json(encode(ui.ComputersSnapshotSchema, await call((api) => api.manageComputer(body))), { headers });
};
