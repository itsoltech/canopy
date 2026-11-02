import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import { scheduleConfiguration } from "./schedule-configuration.ts";

const now = new Date("2026-11-02T12:00:00Z");
const build = (input: Parameters<typeof create<typeof ui.CreateScheduleRequestSchema>>[1]) => scheduleConfiguration(create(ui.CreateScheduleRequestSchema, input), now);

test("create/update recompute a one-off or cron in its timezone from the supplied clock", () => {
  const runAt = new Date("2026-11-03T15:12:00Z");
  expect(build({ prompt: "  Report  ", when: { case: "runAt", value: timestampFromDate(runAt) } })).toMatchObject({
    kind: "once", prompt: "Report", runAt, nextRunAt: runAt, timezone: "UTC", missedPolicy: "run_once",
  });
  expect(build({ prompt: "Report", when: { case: "cron", value: "30 9 * * *" }, timezone: "Europe/Warsaw", maxRuns: 7, missedPolicy: "skip" })).toMatchObject({
    kind: "recurring", nextRunAt: new Date("2026-11-03T08:30:00Z"), maxRuns: 7, missedPolicy: "skip",
  });
});

test("shared validation rejects malformed updates instead of producing invalid stored schedules", () => {
  const request = { prompt: "Report", when: { case: "cron" as const, value: "*/5 * * * *" } };
  for (const extra of [
    { prompt: " " }, { missedPolicy: "unknown" }, { concurrency: "unknown" }, { timezone: "Moon/Sea" },
    { when: { case: "cron" as const, value: "* * * * *" } }, { when: { case: "cron" as const, value: "0 * * * * *" } },
    { maxRuns: 2_147_483_648 }, { until: timestampFromDate(new Date(now.getTime() - 1)) },
    { until: timestampFromDate(new Date(now.getTime() + 1)) },
  ]) expect(() => build({ ...request, ...extra })).toThrow();
  expect(() => build({ prompt: "Report", when: { case: "runAt", value: timestampFromDate(new Date(now.getTime() - 61_000)) } })).toThrow("past");
  expect(() => build({ prompt: "Report", maxRuns: 1, when: { case: "runAt", value: timestampFromDate(now) } })).toThrow("once");
});
