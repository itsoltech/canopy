import { ui } from "@canopy/contracts";
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

export async function updateSchedule(request: ui.UpdateScheduleRequest): Promise<ui.Schedule | undefined> {
  const response = await requestJson("PUT", `/api/schedules/${encodeURIComponent(request.scheduleId)}`, encode(ui.UpdateScheduleRequestSchema, request));
  return decode(ui.UpdateScheduleResponseSchema, response).schedule;
}

export async function previewSchedule(cron: string, timezone: string): Promise<ui.PreviewScheduleResponse> {
  return decode(ui.PreviewScheduleResponseSchema, await requestJson("POST", "/api/schedules/preview", { cron, timezone, count: 3 }));
}

export type ScheduleStatusChange = "active" | "paused" | "cancelled";

export async function setScheduleStatus(scheduleId: string, status: ScheduleStatusChange): Promise<ui.Schedule | undefined> {
  const response = await requestJson("POST", `/api/schedules/${encodeURIComponent(scheduleId)}/status`, { status });
  return decode(ui.SetScheduleStatusResponseSchema, response).schedule;
}
