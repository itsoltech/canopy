import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Workers of the other computers that share configuration, as their homes last recorded them. */
export const GET: RequestHandler = async () =>
  json(encode(ui.ListWorkerRecordsResponseSchema, await call((api) => api.listWorkerRecords({}))), {
    headers: { "cache-control": "no-store" },
  });
