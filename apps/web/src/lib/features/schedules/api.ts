import { ui } from "@open-agents/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Browser-side calls to the BFF for schedules. */
export async function listSchedules(filter: { projectId?: string; threadId?: string; includeFinished?: boolean } = {}): Promise<ui.Schedule[]> {
  const query = new URLSearchParams();
  if (filter.projectId) query.set("projectId", filter.projectId);
  if (filter.threadId) query.set("threadId", filter.threadId);
  if (filter.includeFinished) query.set("includeFinished", "true");
  return decode(ui.ListSchedulesResponseSchema, await requestJson("GET", `/api/schedules?${query}`)).schedules;
}

export async function createSchedule(request: ui.CreateScheduleRequest): Promise<ui.Schedule | undefined> {
  return decode(ui.CreateScheduleResponseSchema, await requestJson("POST", "/api/schedules", encode(ui.CreateScheduleRequestSchema, request))).schedule;
}

export type ScheduleStatusChange = "active" | "paused" | "cancelled";

export async function setScheduleStatus(scheduleId: string, status: ScheduleStatusChange): Promise<ui.Schedule | undefined> {
  const response = await requestJson("POST", `/api/schedules/${encodeURIComponent(scheduleId)}/status`, { status });
  return decode(ui.SetScheduleStatusResponseSchema, response).schedule;
}
