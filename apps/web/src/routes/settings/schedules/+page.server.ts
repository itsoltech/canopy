import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { PageServerLoad } from "./$types";

/** Every schedule of yours, finished ones too; the page follows changes live. */
export const load: PageServerLoad = async () => {
  const response = await call((api) => api.listSchedules({ includeFinished: true }));
  return { schedules: encode(ui.ListSchedulesResponseSchema, response) };
};
