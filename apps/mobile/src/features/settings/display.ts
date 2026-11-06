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
