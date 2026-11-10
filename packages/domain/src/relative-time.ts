import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

/** Round before choosing the unit so 59.5 minutes and 23.5 hours carry into the next unit. */
function relativeUnit(seconds: number) {
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return { value: minutes, unit: "minute" } as const;
  const hours = Math.round(seconds / 3600);

  if (hours < 24) return { value: hours, unit: "hour" } as const;
  const days = Math.round(seconds / 86400);

  if (days < 14) return { value: days, unit: "day" } as const;

  return { value: Math.round(seconds / (86400 * 7)), unit: "week" } as const;
}

/** English relative time on every client, including Hermes without Intl.RelativeTimeFormat. */
export function formatRelative(
  timestamp: Timestamp | undefined,
  now = Date.now(),
  style: "long" | "short" = "long",
): string {
  if (!timestamp) return "";
  const seconds = (now - timestampDate(timestamp).getTime()) / 1000;

  if (Math.abs(seconds) < 45) return style === "short" ? "now" : "just now";
  const { value, unit } = relativeUnit(Math.abs(seconds));

  if (style === "short") return seconds < 0 ? "now" : `${value}${unit[0]}`;

  if (unit === "day" && value === 1) return seconds < 0 ? "tomorrow" : "yesterday";
  const span = `${value} ${unit}${value === 1 ? "" : "s"}`;

  return seconds < 0 ? `in ${span}` : `${span} ago`;
}

/** Compact age for lists: "now", "5m", "3h", "2d", "4w", with the same rounding as full relative time. */
export function formatAge(timestamp: Timestamp | undefined, now = Date.now()): string {
  return formatRelative(timestamp, now, "short");
}
