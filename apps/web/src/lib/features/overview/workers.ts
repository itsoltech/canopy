import type { ui } from "@canopy/contracts";
import { providerLabel } from "#lib/features/threads/labels.ts";

/** Worker OS as reported by the worker (`process.platform`). */
export function osLabel(os: string): string {
  switch (os) {
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return os || "Unknown OS";
  }
}

/** "Online · Linux" or "Offline". */
export const workerStatus = (worker: ui.Worker | undefined): string =>
  `${worker?.online ? "Online" : "Offline"}${worker?.os ? ` · ${osLabel(worker.os)}` : ""}`;

/** Path separator on the worker: paths follow the worker's system, not the browser's. */
export const pathSeparator = (os: string): string => (os === "win32" ? "\\" : "/");

/** "Codex 0.5.1", or why it is not usable. */
export const providerSummary = (provider: ui.Worker["providers"][number]): string =>
  `${providerLabel(provider.provider)}${provider.available ? (provider.version ? ` ${provider.version}` : ", version unknown") : ` unavailable${provider.detail ? `: ${provider.detail}` : ""}`}`;

/** The worker has not applied its latest configuration yet. */
export const configPending = (worker: ui.Worker): boolean => worker.appliedVersion < worker.configVersion;
