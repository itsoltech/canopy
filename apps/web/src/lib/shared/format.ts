import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

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

export const formatDateTime = (timestamp: Timestamp | undefined): string => (timestamp ? dateTime.format(timestampDate(timestamp)) : "");

export const isoDateTime = (timestamp: Timestamp | undefined): string => (timestamp ? timestampDate(timestamp).toISOString() : "");

/** Pretty-prints JSON; returns the input unchanged when it is not JSON. */
export function prettyJson(json: string): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** Parses a JSON object; anything else (invalid, array, scalar) gives an empty record. */
export function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Last segment of a path in either separator style. */
export const basename = (path: string): string => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
