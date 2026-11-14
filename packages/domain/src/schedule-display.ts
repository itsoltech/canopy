import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";

/** The API falls back to the first 60 message characters when no explicit name was saved. */
export function scheduleHeading(schedule: Pick<ui.Schedule, "name" | "prompt">): string {
  const name = schedule.name.trim();
  const prefix = name.replace(/(?:…|\.{3})$/, "").trimEnd();

  return !prefix || prefix === schedule.prompt.trim() || prefix === schedule.prompt.slice(0, 60).trim()
    ? schedule.prompt
    : name;
}

export function scheduleRunLabel(outcome: string): string {
  switch (outcome) {
    case "started":
      return "Started";
    case "missed":
      return "Missed";
    case "running":
      return "Skipped: previous run working";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
    default:
      return outcome || "Unknown";
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: string) => value.padStart(2, "0");

/** Common cron expressions in words; unfamiliar expressions remain visible verbatim. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) return cron;
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  const number = /^\d+$/;
  const at = number.test(minute) && number.test(hour) ? `${pad(hour)}:${pad(minute)}` : undefined;
  const every = /^\*\/(\d+)$/.exec(minute);

  if (every && hour === "*" && day === "*" && month === "*" && weekday === "*") return `Every ${every[1]} minutes`;

  if (number.test(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*")
    return `Hourly at :${pad(minute)}`;

  if (!at || month !== "*") return cron;

  if (day === "*" && weekday === "*") return `Daily at ${at}`;

  if (day === "*" && weekday === "1-5") return `Weekdays at ${at}`;

  if (day === "*" && /^[0-7]$/.test(weekday)) return `Every ${DAYS[Number(weekday) % 7]} at ${at}`;

  if (number.test(day) && weekday === "*") return `Monthly on day ${day} at ${at}`;

  return cron;
}

const hour = 3_600_000;

/** When a duplicated task first runs (a one-off) and when it ends (an end date). */
export interface DuplicateScheduleTimes {
  runAt: Date;
  until?: Date;
}

/**
 * Times for a new task copied from `schedule` (Duplicate): a one-off time that has passed moves to the next
 * full hour; an end date that has passed keeps the original task's span, counted from `now`.
 */
export function duplicateScheduleTimes(
  schedule: Pick<ui.Schedule, "runAt" | "until" | "createdAt">,
  now: Date,
): DuplicateScheduleTimes {
  const runAt = schedule.runAt ? timestampDate(schedule.runAt) : undefined;
  const nextHour = new Date(now.getTime() + hour);
  nextHour.setMinutes(0, 0, 0);
  const times: DuplicateScheduleTimes = { runAt: runAt && runAt > now ? runAt : nextHour };

  if (!schedule.until) return times;
  const until = timestampDate(schedule.until);
  const span = schedule.createdAt ? until.getTime() - timestampDate(schedule.createdAt).getTime() : 0;

  return { ...times, until: until > now ? until : new Date(now.getTime() + (span > 0 ? span : 7 * 24 * hour)) };
}
