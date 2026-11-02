import { expect, test } from "bun:test";
import { scheduleTiming } from "./scheduler.ts";

const due = new Date("2026-11-02T08:00:00Z");
const recurring = { next_run_at: due, kind: "recurring" as const, cron: "0 9 * * *", timezone: "Europe/Warsaw", missed_policy: "run_once" as const };
test("new-thread catch-up coalesces missed cron occurrences and preserves the time zone", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  expect(scheduleTiming(recurring, now)).toEqual({ run: true, late: true, nextRunAt: new Date("2026-11-07T08:00:00Z") });
  expect(scheduleTiming({ ...recurring, missed_policy: "skip" }, now)).toMatchObject({ run: false, late: true });
});
test("five-second ticks tolerate two minutes of lateness before applying skip", () => {
  expect(scheduleTiming({ ...recurring, missed_policy: "skip" }, new Date(due.getTime() + 120_000)).run).toBe(true);
  expect(scheduleTiming({ ...recurring, missed_policy: "skip" }, new Date(due.getTime() + 120_001)).run).toBe(false);
});
test("a once-schedule has no next occurrence and a late run follows missed policy", () => {
  expect(scheduleTiming({ ...recurring, kind: "once", cron: null }, new Date(due.getTime() + 600_000))).toEqual({ run: true, late: true, nextRunAt: undefined });
  expect(scheduleTiming({ ...recurring, kind: "once", cron: null, missed_policy: "skip" }, new Date(due.getTime() + 600_000)).run).toBe(false);
});
