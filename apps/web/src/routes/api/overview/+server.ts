import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Ready process-local overview, maintained by the shared gateway stream. */
export const GET: RequestHandler = async () =>
  json(encode(ui.GetOverviewResponseSchema, await call(() => bffSession().overview.overview())));
