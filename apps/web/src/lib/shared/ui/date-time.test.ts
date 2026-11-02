import { describe, expect, test } from "bun:test";
import { calendarDays, dateTimeError, formatDateTime, localValue, parseDateTime, parseDay, shiftDay, shiftMonth, stepTime } from "./date-time.ts";

describe("date/time wire values and locale display", () => {
  test("one instant round-trips in zones on different sides of UTC", () => {
    const instant = new Date("2026-11-02T10:45:00Z");
    for (const [zone, expected] of [["Europe/Warsaw", "2026-11-02T11:45"], ["America/New_York", "2026-11-02T05:45"], ["Asia/Kathmandu", "2026-11-02T16:30"], ["Pacific/Auckland", "2026-11-02T23:45"]]) {
      expect(localValue(instant, "datetime-local", zone)).toBe(expected!);
      expect(parseDateTime(expected!, zone)?.toISOString()).toBe(instant.toISOString());
    }
    expect(localValue(new Date("2026-11-02T23:30Z"), "datetime-local", "Europe/Warsaw")).toBe("2026-11-03T00:30");
  });
  test("Warsaw spring DST gap is rejected, adjacent minutes round-trip", () => {
    expect(parseDateTime("2026-03-29T02:30", "Europe/Warsaw")).toBeUndefined();
    expect(parseDateTime("2026-03-29T01:59", "Europe/Warsaw")?.toISOString()).toBe("2026-03-29T00:59:00.000Z");
    expect(parseDateTime("2026-03-29T03:00", "Europe/Warsaw")?.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(dateTimeError("2026-03-29T02:30", "datetime-local", undefined, undefined, "Europe/Warsaw")).toContain("clocks change");
  });
  test("Warsaw autumn fold chooses the earlier instant, preserving the old value shape", () => {
    expect(parseDateTime("2026-10-25T02:30", "Europe/Warsaw")?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(localValue(new Date("2026-10-25T01:30Z"), "datetime-local", "Europe/Warsaw")).toBe("2026-10-25T02:30");
  });
  test("formatting uses the requested locale without shifting a calendar date or wall time", () => {
    expect(formatDateTime("2026-11-02T11:45", "datetime-local", "pl-PL", "Europe/Warsaw")).toContain("11:45");
    expect(formatDateTime("2026-11-02", "date", "en-US", "America/Los_Angeles")).toBe("Nov 2, 2026");
    expect(formatDateTime("09:00", "time", "en-US", "Europe/Warsaw")).toContain("9:00");
    expect(formatDateTime("09:00", "time", "pl-PL")).toBe("09:00");
  });
  test("invalid calendar dates and times are rejected and bounds are inclusive", () => {
    expect(parseDay("2026-02-29")).toBeUndefined();
    expect(parseDay("2028-02-29")).toBeDefined();
    for (const value of ["2026-11-02T24:00", "2026-11-02T09:60", "2026-02-30T09:00", "bad"]) expect(parseDateTime(value, "UTC")).toBeUndefined();
    expect(dateTimeError("09:00", "time", "09:00", "10:00")).toBeUndefined();
    expect(dateTimeError("08:59", "time", "09:00")).toContain("later");
    expect(dateTimeError("10:01", "time", undefined, "10:00")).toContain("earlier");
  });
  test("calendar navigation handles month boundaries, leap days and time wrap", () => {
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftMonth("2028-01-31", 1)).toBe("2028-02-29");
    expect(shiftMonth("2028-02-29", 12)).toBe("2029-02-28");
    const grid = calendarDays("2026-11-02").flat();
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-11-01");
    expect(stepTime("23:55", 15)).toBe("00:10");
    expect(stepTime("00:00", -1)).toBe("23:59");
  });
});
