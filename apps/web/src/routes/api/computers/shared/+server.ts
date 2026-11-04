import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Shared configuration with linked computers (docs/linked-computers.md, stage 4). Never carries secret values. */
const headers = { "cache-control": "no-store" };

export const GET: RequestHandler = async () =>
  json(encode(ui.SharedConfigSnapshotSchema, await call((api) => api.getSharedConfig({}))), { headers });

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SharedConfigOperationSchema);

  return json(encode(ui.SharedConfigSnapshotSchema, await call((api) => api.manageSharedConfig(body))), { headers });
};
