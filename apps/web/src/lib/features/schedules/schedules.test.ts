import { expect, test } from "bun:test";
import { scheduleActions } from "./schedules.ts";

test("both schedule menus offer only actions valid for the current status", () => {
  expect(scheduleActions("active")).toEqual(["edit", "pause", "cancel"]);
  expect(scheduleActions("paused")).toEqual(["edit", "resume", "cancel"]);
  for (const status of ["completed", "cancelled", "unknown"]) expect(scheduleActions(status)).toEqual([]);
});
