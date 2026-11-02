import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async () => json(encode(ui.GetWorkerSetupResponseSchema, await call((api) => api.getWorkerSetup({}))), { headers: { "cache-control": "no-store" } });
