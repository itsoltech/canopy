import { useDevicePreferences } from "./device-preferences";
import { effortLabel } from "../models/catalog";

export function useEffortLabel() {
  const { values } = useDevicePreferences();

  return (effort: string) => {
    const level = ["minimal", "low", "medium", "high", "xhigh", "max"].indexOf(effort);

    return values.effortDisplay === "bars" && level >= 0 ? "▮".repeat(level + 1) : effortLabel(effort);
  };
}

export function useDateTime() {
  const { values } = useDevicePreferences();

  return (seconds?: bigint) =>
    seconds === undefined
      ? "—"
      : new Date(Number(seconds) * 1000).toLocaleString(undefined, {
          hour12: values.timeFormat === "system" ? undefined : values.timeFormat === "12h",
        });
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Times of the timeline and chats in General → Time format (web: format.ts, chat-timeline.ts): "8:44 PM", a day pill
 * ("Today", "Yesterday", "Nov 2, 2026") and a chat's date line ("Today 8:44 PM", "Monday 8:44 PM", "Oct 3, 8:44 PM").
 */
export function useClock() {
  const { values } = useDevicePreferences();
  const hour12 = values.timeFormat === "system" ? undefined : values.timeFormat === "12h";
  const time = (at: Date) => at.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit", hour12 });
  const days = (at: Date, now: Date) => Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return {
    time,
    day(at: Date, now = new Date()) {
      const n = days(at, now);

      return n === 0
        ? "Today"
        : n === 1
          ? "Yesterday"
          : at.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
    },
    dateLine(at: Date, now = new Date()) {
      const n = days(at, now);

      if (n <= 0) return `Today ${time(at)}`;

      if (n === 1) return `Yesterday ${time(at)}`;

      if (n < 7) return `${at.toLocaleDateString("en", { weekday: "long" })} ${time(at)}`;
      const date: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

      if (at.getFullYear() !== now.getFullYear()) date.year = "numeric";

      return `${at.toLocaleDateString("en", date)}, ${time(at)}`;
    },
  };
}
