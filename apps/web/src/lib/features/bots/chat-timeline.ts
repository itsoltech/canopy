import { clockOptions } from "#lib/shared/format.ts";

export {
  exchangePhrases,
  layoutChat,
  type ChatLayoutInput,
  type ChatRow,
  type ExchangePhrase,
  type ExchangeSegment,
} from "@canopy/domain/bot-chat";

const time = () => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", ...clockOptions() });
const weekday = new Intl.DateTimeFormat("en", { weekday: "long" });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const full = () => new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short", ...clockOptions() });

/** "Today 8:44 PM", "Yesterday 9:10 AM", "Monday 8:44 PM", "Oct 3, 8:44 PM", "Oct 3, 2025, 8:44 PM". */
export function dateLineLabel(at: Date, now: number): string {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const days = Math.floor(
    (startOfToday - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000,
  );

  const clock = time().format(at);

  if (days <= 0) return `Today ${clock}`;

  if (days === 1) return `Yesterday ${clock}`;

  if (days < 7) return `${weekday.format(at)} ${clock}`;

  return `${(at.getFullYear() === today.getFullYear() ? monthDay : fullDate).format(at)}, ${clock}`;
}

/** "8:44 PM". */
export const timeLabel = (at: Date): string => time().format(at);

/** Full date and time for tooltips. */
export const fullDateLabel = (at: Date): string => full().format(at);

const shortWeekday = new Intl.DateTimeFormat("en", { weekday: "short" });

/** Time of the last message in a list: "8:44 PM" today, "Yesterday", "Mon", then "Oct 3". */
export function listTimeLabel(at: Date, now: number): string {
  const label = dateLineLabel(at, now);

  if (label.startsWith("Today")) return time().format(at);

  if (label.startsWith("Yesterday")) return "Yesterday";
  const days = (now - at.getTime()) / 86_400_000;

  return days < 7
    ? shortWeekday.format(at)
    : (at.getFullYear() === new Date(now).getFullYear() ? monthDay : fullDate).format(at);
}
