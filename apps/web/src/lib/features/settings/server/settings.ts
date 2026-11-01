import { isHttpError } from "@sveltejs/kit";
import type { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";

/**
 * The user's and projects' settings from the gateway; `null` while the gateway is down (the page then
 * renders with default appearance and the live stream fills the settings in later).
 */
export async function loadSettings(): Promise<ui.GetSettingsResponse | null> {
  try {
    return await call((api) => api.getSettings({}));
  } catch (cause) {
    if (isHttpError(cause) && cause.status >= 500) return null;
    throw cause;
  }
}
