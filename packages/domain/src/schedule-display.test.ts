import { describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describeCron, duplicateScheduleTimes, scheduleHeading } from "./schedule-display.ts";

describe("scheduled task presentation", () => {
  test("legacy message prefixes do not become duplicate titles, including mid-word truncation", () => {
    const prompt = "Sprawdź czy Maciej wrzucił zmiany w wątku na slack, jeżeli tak to zrób kolejną rundę review";

    for (const name of ["", prompt, prompt.slice(0, 60), `${prompt.slice(0, 60)}…`, `${prompt.slice(0, 60)}...`])
      expect(scheduleHeading({ name, prompt })).toBe(prompt);

    expect(scheduleHeading({ name: "Security review", prompt })).toBe("Security review");
    expect(scheduleHeading({ name: "Sprawdź", prompt })).toBe("Sprawdź");
  });

  test("compact recurring descriptions retain minute, day and weekday meaning", () => {
    expect(describeCron("0 * * * *")).toBe("Hourly at :00");
    expect(describeCron("5 * * * *")).toBe("Hourly at :05");
    expect(describeCron("30 9 * * *")).toBe("Daily at 09:30");
    expect(describeCron("0 18 * * 1-5")).toBe("Weekdays at 18:00");
    expect(describeCron("0 8 * * 7")).toBe("Every Sunday at 08:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 8 1 * *")).toBe("Monthly on day 1 at 08:00");
    expect(describeCron("0 8 * 1-3 1,3")).toBe("0 8 * 1-3 1,3");
  });

  test("a duplicate never starts in the past and keeps the original span to its end date", () => {
    const now = new Date(2026, 10, 14, 10, 20);
    const at = (date: Date) => timestampFromDate(date);
    const created = new Date(2026, 10, 1, 9, 0);
    const ended = new Date(2026, 10, 4, 9, 0);

    expect(duplicateScheduleTimes({ runAt: at(new Date(2026, 10, 12, 9, 0)) }, now)).toEqual({
      runAt: new Date(2026, 10, 14, 11, 0),
    });
    expect(duplicateScheduleTimes({ runAt: at(new Date(2026, 10, 20, 9, 0)) }, now).runAt).toEqual(
      new Date(2026, 10, 20, 9, 0),
    );
    expect(duplicateScheduleTimes({ createdAt: at(created), until: at(ended) }, now).until).toEqual(
      new Date(now.getTime() + 3 * 24 * 3_600_000),
    );
    expect(duplicateScheduleTimes({ until: at(new Date(2026, 10, 30)) }, now).until).toEqual(new Date(2026, 10, 30));
  });
});
