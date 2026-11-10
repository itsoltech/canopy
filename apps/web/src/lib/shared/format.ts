import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

export {
  dayKey,
  formatAge,
  formatRelative,
  formatBytes,
  formatCount,
  formatDuration,
  formatSpan,
  prettyJson,
} from "@canopy/domain/format";

export { basename } from "@canopy/domain/humanize";

import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

/** The 12/24-hour clock of General → Time format, for any formatter that shows a time. */
export function clockOptions(): Intl.DateTimeFormatOptions {
  const format = devicePreferences.values.timeFormat;

  return format === "system" ? {} : { hour12: format === "12h" };
}

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale and options: creating one costs far more than formatting, and lists format per row. */
function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }

  return formatter;
}

export const formatLocalDateTime = (value: Date, timeZone?: string): string =>
  dateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...clockOptions(),
    ...(timeZone && { timeZone }),
  }).format(value);

export const formatDateTime = (timestamp: Timestamp | undefined, timeZone?: string): string =>
  timestamp ? formatLocalDateTime(timestampDate(timestamp), timeZone) : "";

/** English date text with the device's selected clock and local time zone. */
export const formatEnglishDateTime = (timestamp: Timestamp | undefined): string =>
  timestamp
    ? dateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", ...clockOptions() }).format(
        timestampDate(timestamp),
      )
    : "";

export const formatTime = (timestamp: Timestamp | undefined, timeZone?: string): string =>
  timestamp
    ? dateTimeFormat(undefined, {
        timeStyle: "short",
        ...clockOptions(),
        ...(timeZone && { timeZone }),
      }).format(timestampDate(timestamp))
    : "";

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
