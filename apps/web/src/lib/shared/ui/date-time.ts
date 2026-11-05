export type DateTimeKind = "date" | "time" | "datetime-local";

import { clockOptions } from "#lib/shared/format.ts";

const pad = (value: number) => String(value).padStart(2, "0");
export const userTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Wire values remain local ISO strings, as with the old inputs; never append a misleading Z. */
export function localValue(date: Date, kind: DateTimeKind = "datetime-local", timeZone = userTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const time = `${part("hour")}:${part("minute")}`;

  switch (kind) {
    case "date":
      return day;
    case "time":
      return time;
    default:
      return `${day}T${time}`;
  }
}

export function parseDay(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T12:00:00Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : undefined;
}

export const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Resolve wall time in an IANA zone. Reject DST gaps; folds choose the earlier instant,
 * matching Date's existing compatible disambiguation. Offset candidates cover both sides of DST. */
export function parseDateTime(value: string, timeZone = userTimeZone()): Date | undefined {
  const [day, time, extra] = value.split("T");

  if (extra !== undefined || !day || !time || !parseDay(day) || !validTime(time)) return undefined;
  const naive = Date.parse(`${value}:00Z`);
  const offsets = new Set<number>();

  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const instant = naive + delta;
    offsets.add(Date.parse(`${localValue(new Date(instant), "datetime-local", timeZone)}:00Z`) - instant);
  }

  const matches = [...offsets].flatMap((offset) => {
    const date = new Date(naive - offset);

    return localValue(date, "datetime-local", timeZone) === value ? [date] : [];
  });

  return matches.sort((a, b) => a.getTime() - b.getTime())[0];
}

export function formatDateTime(value: string, kind: DateTimeKind, locale?: string, timeZone = userTimeZone()): string {
  if (!value) return "";

  if (kind === "time")
    return validTime(value)
      ? new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC", ...clockOptions() }).format(
          new Date(`2000-01-01T${value}:00Z`),
        )
      : value;

  if (kind === "date") {
    const date = parseDay(value);

    return date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date) : value;
  }

  const date = parseDateTime(value, timeZone);

  return date
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone, ...clockOptions() }).format(
        date,
      )
    : value;
}

function parseValue(value: string, kind: DateTimeKind, timeZone: string): Date | boolean | undefined {
  switch (kind) {
    case "time":
      return validTime(value);
    case "date":
      return parseDay(value);
    default:
      return parseDateTime(value, timeZone);
  }
}

export function dateTimeError(
  value: string,
  kind: DateTimeKind,
  min?: string,
  max?: string,
  timeZone = userTimeZone(),
): string | undefined {
  const valid = parseValue(value, kind, timeZone);

  if (!valid)
    return kind === "time"
      ? "Enter a time as HH:MM (00:00–23:59)."
      : "Choose a valid date and time. This time may not exist because the clocks change.";

  if (min && value < min) return `Choose ${formatDateTime(min, kind, undefined, timeZone)} or later.`;

  if (max && value > max) return `Choose ${formatDateTime(max, kind, undefined, timeZone)} or earlier.`;

  return undefined;
}

export function shiftDay(day: string, days: number): string {
  const date = parseDay(day)!;
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

export function shiftMonth(day: string, months: number): string {
  const date = parseDay(day)!;
  const wanted = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(wanted, last));

  return date.toISOString().slice(0, 10);
}

export function calendarDays(day: string): string[][] {
  const first = `${day.slice(0, 7)}-01`;
  const start = shiftDay(first, -parseDay(first)!.getUTCDay());

  return Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 7 }, (_, column) => shiftDay(start, row * 7 + column)),
  );
}

export function stepTime(time: string, minutes: number): string {
  const [hour, minute] = (validTime(time) ? time : "09:00").split(":").map(Number);
  const total = (((hour! * 60 + minute! + minutes) % 1440) + 1440) % 1440;

  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
