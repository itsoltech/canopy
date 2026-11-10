/** Numbers and spans of time as the timeline shows them, the same on every client. */
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

export { connectorStatus, connectorAccessSummary } from "./connector-display.ts";

/** Calendar day in the device's local time, shared by thread timeline projections. */
export function dayKey(timestamp: Timestamp | undefined): string {
  if (!timestamp) return "";
  const date = timestampDate(timestamp);

  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Compact age for lists: "now", "5m", "3h", "2d", "4w". Hermes has no Intl.RelativeTimeFormat. */
export function formatAge(timestamp: Timestamp | undefined, now = Date.now()): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, (now - timestampDate(timestamp).getTime()) / 1000);

  if (seconds < 60) return "now";

  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;

  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)}d`;

  return `${Math.floor(seconds / (86400 * 7))}w`;
}

const UNITS = [
  [1e3, "K"],
  [1e6, "M"],
  [1e9, "B"],
  [1e12, "T"],
] as const;

const tenths = (value: number) => Math.round(value * 10) / 10;

/** 1234 → "1.2K", 12000 → "12K": compact English notation with one decimal at most (Hermes has no compact Intl). */
export function formatCount(value: bigint | number): string {
  const n = Number(value);

  for (let at = UNITS.length - 1; at >= 0; at--) {
    const [size, unit] = UNITS[at]!;

    if (Math.abs(n) < size) continue;
    const scaled = tenths(n / size);
    const next = UNITS[at + 1];

    return next && Math.abs(scaled) >= 1000 ? `${Math.sign(n)}${next[1]}` : `${scaled}${unit}`;
  }

  return `${tenths(n)}`;
}

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

/** Pretty-prints JSON; returns the input unchanged when it is not JSON. */
export function prettyJson(json: string): string {
  if (!json) return "";

  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
