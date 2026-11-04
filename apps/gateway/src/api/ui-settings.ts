import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function settingsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listSchedules"
  | "createSchedule"
  | "updateSchedule"
  | "getSettings"
  | "updateUserSettings"
  | "updateProjectSettings"
  | "previewSchedule"
  | "setScheduleStatus"
> {
  return {
    listSchedules: (request) =>
      guard(async () => create(ui.ListSchedulesResponseSchema, { schedules: await core.listSchedules(request) })),

    createSchedule: (request) =>
      guard(async () => create(ui.CreateScheduleResponseSchema, { schedule: await core.createSchedule(request) })),

    updateSchedule: (request) =>
      guard(async () => create(ui.UpdateScheduleResponseSchema, { schedule: await core.updateSchedule(request) })),

    getSettings: () => guard(() => core.settings()),

    updateUserSettings: (request) =>
      guard(async () =>
        create(ui.UpdateUserSettingsResponseSchema, { settings: await core.updateUserSettings(request) }),
      ),

    updateProjectSettings: (request) =>
      guard(async () =>
        create(ui.UpdateProjectSettingsResponseSchema, { settings: await core.updateProjectSettings(request) }),
      ),

    previewSchedule: (request) => guard(async () => core.previewSchedule(request)),

    setScheduleStatus: (request) =>
      guard(async () =>
        create(ui.SetScheduleStatusResponseSchema, { schedule: await core.setScheduleStatus(request) }),
      ),
  };
}
