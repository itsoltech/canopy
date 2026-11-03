import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Schedules of a thread, a project or all of yours (`?threadId=`, `?projectId=`, `?includeFinished=true`). */
export const GET: RequestHandler = async ({ url }) => {
  const response = await call((api) =>
    api.listSchedules({
      threadId: url.searchParams.get("threadId") ?? "",
      projectId: url.searchParams.get("projectId") ?? "",
      includeFinished: url.searchParams.get("includeFinished") === "true",
    }),
  );
  return json(encode(ui.ListSchedulesResponseSchema, response));
};

/** A new schedule of yours: one-off (`runAt`) or recurring (`cron` + `timezone`). */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.CreateScheduleRequestSchema);
  return json(encode(ui.CreateScheduleResponseSchema, await call((api) => api.createSchedule(body))));
};
