import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

export { formatAge, formatBytes, formatCount, formatDuration, formatSpan, prettyJson } from "@canopy/domain/format";

export { basename } from "@canopy/domain/humanize";

import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** The 12/24-hour clock of General → Time format, for any formatter that shows a time. */
export function clockOptions(): Intl.DateTimeFormatOptions {
  const format = devicePreferences.values.timeFormat;

  return format === "system" ? {} : { hour12: format === "12h" };
}

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** "5 minutes ago"; `now` is passed in so callers can tick it. */
export function formatRelative(timestamp: Timestamp | undefined, now = Date.now()): string {
  if (!timestamp) return "";
  const diff = (timestampDate(timestamp).getTime() - now) / 1000;
  const abs = Math.abs(diff);

  if (abs < 45) return "just now";

  if (abs < 3600) return relative.format(Math.round(diff / 60), "minute");

  if (abs < 86400) return relative.format(Math.round(diff / 3600), "hour");

  return relative.format(Math.round(diff / 86400), "day");
}

export const formatLocalDateTime = (value: Date, timeZone?: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...clockOptions(),
    ...(timeZone && { timeZone }),
  }).format(value);

export const formatDateTime = (timestamp: Timestamp | undefined, timeZone?: string): string =>
  timestamp ? formatLocalDateTime(timestampDate(timestamp), timeZone) : "";

export const formatTime = (timestamp: Timestamp | undefined, timeZone?: string): string =>
  timestamp
    ? new Intl.DateTimeFormat(undefined, {
        timeStyle: "short",
        ...clockOptions(),
        ...(timeZone && { timeZone }),
      }).format(timestampDate(timestamp))
    : "";

/** The local calendar day of a timestamp ("2026-11-02"), for telling days apart; "" without one. */
export function dayKey(timestamp: Timestamp | undefined): string {
  if (!timestamp) return "";
  const at = timestampDate(timestamp);

  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/** A day separator's label: "Today", "Yesterday" or the date ("Nov 2, 2026"). */
export function formatDay(timestamp: Timestamp | undefined, now = new Date()): string {
  if (!timestamp) return "";
  const at = timestampDate(timestamp);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  if (days === 0) return "Today";

  if (days === 1) return "Yesterday";

  return date.format(at);
}

export const isoDateTime = (timestamp: Timestamp | undefined): string =>
  timestamp ? timestampDate(timestamp).toISOString() : "";
