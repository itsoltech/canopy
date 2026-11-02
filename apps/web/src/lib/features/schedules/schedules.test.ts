import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { scheduleActions, upsertSchedule } from "./schedules.ts";

test("both schedule menus offer only actions valid for the current status", () => {
  expect(scheduleActions("active")).toEqual(["edit", "pause", "cancel"]);
  expect(scheduleActions("paused")).toEqual(["edit", "resume", "cancel"]);
  for (const status of ["completed", "cancelled", "unknown"]) expect(scheduleActions(status)).toEqual([]);
});

test("a late save response cannot restore actions after the stream finished the task", () => {
  const saved = create(ui.ScheduleSchema, { id: "task", status: "active", version: 2 });
  const completed = create(ui.ScheduleSchema, { id: "task", status: "completed", version: 3, runs: 1 });
  const streamed = upsertSchedule([saved], completed);
  expect(upsertSchedule(streamed, saved)).toEqual([completed]);
  expect(scheduleActions(upsertSchedule(streamed, saved)[0]!.status)).toEqual([]);
});
