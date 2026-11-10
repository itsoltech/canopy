import { describe, expect, test } from "bun:test";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { formatAge, formatRelative } from "./format.ts";

const now = Date.UTC(2026, 10, 10, 12);

describe("relative time shared by web and native lists", () => {
  test.each([
    [59.49 * 60, "59 minutes ago", "59m"],
    [59.5 * 60, "1 hour ago", "1h"],
    [60 * 60, "1 hour ago", "1h"],
    [23.49 * 3600, "23 hours ago", "23h"],
    [23.5 * 3600, "yesterday", "1d"],
    [24 * 3600, "yesterday", "1d"],
    [47.5 * 3600, "2 days ago", "2d"],
  ])("carries %s seconds into the same unit in both styles", (seconds, long, short) => {
    const timestamp = timestampFromMs(now - seconds * 1000);

    expect(formatRelative(timestamp, now)).toBe(long);
    expect(formatRelative(timestamp, now, "short")).toBe(short);
    expect(formatAge(timestamp, now)).toBe(short);
  });

  test("rounds future times symmetrically while ages stay at now", () => {
    const hour = timestampFromMs(now + 59.5 * 60_000);
    const day = timestampFromMs(now + 23.5 * 3_600_000);

    expect(formatRelative(hour, now)).toBe("in 1 hour");
    expect(formatRelative(day, now)).toBe("tomorrow");
    expect(formatAge(hour, now)).toBe("now");
  });
});
