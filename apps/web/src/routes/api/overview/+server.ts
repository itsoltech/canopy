import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Full overview, for resynchronising after the live stream reconnects (it only carries changes). */
export const GET: RequestHandler = async () => json(encode(ui.GetOverviewResponseSchema, await call((api) => api.getOverview({}))));
