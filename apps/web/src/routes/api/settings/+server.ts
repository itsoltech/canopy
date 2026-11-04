import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** The user's and projects' settings (reloaded after a conflict or a reconnect). */
export const GET: RequestHandler = async () =>
  json(encode(ui.GetSettingsResponseSchema, await call((api) => api.getSettings({}))));
