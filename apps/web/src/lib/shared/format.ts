import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** The 12/24-hour clock of General → Time format, for any formatter that shows a time. */
export function clockOptions(): Intl.DateTimeFormatOptions {
  const format = devicePreferences.values.timeFormat;

  return format === "system" ? {} : { hour12: format === "12h" };
}

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** 1234 → "1.2K". */
export const formatCount = (value: bigint | number): string => compact.format(Number(value));

/** 3500 → "3.5s", 125000 → "2m 5s". */
export function formatDuration(ms: bigint | number): string {
  const total = Number(ms);

  if (total < 1000) return `${total}ms`;
  const seconds = total / 1000;

  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);

  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** A span of time for "Worked for …": 12000 → "12s", 134000 → "2m 14s", 3780000 → "1h 3m" (whole units, at least 1s). */
export function formatSpan(ms: bigint | number): string {
  const seconds = Math.max(1, Math.floor(Number(ms) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes: bigint | number): string {
  const value = Number(bytes);

  if (value < 1024) return `${value} B`;

  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;

  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

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

/** Compact age for lists: "now", "5m", "3h", "2d", "4w". */
export function formatAge(timestamp: Timestamp | undefined, now = Date.now()): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, (now - timestampDate(timestamp).getTime()) / 1000);

  if (seconds < 60) return "now";

  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;

  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)}d`;

  return `${Math.floor(seconds / (86400 * 7))}w`;
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

/** Pretty-prints JSON; returns the input unchanged when it is not JSON. */
export function prettyJson(json: string): string {
  if (!json) return "";

  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** Last segment of a path in either separator style. */
export const basename = (path: string): string => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
