import { describe, expect, test } from "bun:test";
import { cronProblem, nextCronRun } from "./cron.ts";

const now = new Date("2026-11-01T18:07:00Z");

describe("cron", () => {
  test("next run in a time zone (DST-aware)", () => {
    expect(nextCronRun("0 9 * * MON", "Europe/Warsaw", now)?.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(nextCronRun("0 9 * * *", "Europe/Warsaw", new Date("2026-03-28T12:00:00Z"))?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(nextCronRun("*/30 * * * *", "UTC", now)?.toISOString()).toBe("2026-11-01T18:30:00.000Z");
  });

  test("minimum interval is checked on real gaps", () => {
    expect(cronProblem("*/30 * * * *", "UTC", 5, now)).toBeUndefined();
    expect(cronProblem("*/5 * * * *", "UTC", 5, now)).toBeUndefined();
    expect(cronProblem("*/2 * * * *", "UTC", 5, now)).toContain("more often than every 5 minutes");
    expect(cronProblem("0,1,2 * * * *", "UTC", 5, now)).toContain("more often");
    expect(cronProblem("0 0 30 2 *", "UTC", 5, now)).toBeDefined();
    expect(cronProblem("not a cron", "UTC", 5, now)).toBeDefined();
  });
});
