import { compareVersions } from "@canopy/updater";

export const updateBusyState = (state: string | undefined) =>
  ["queued", "waiting_idle", "downloading", "restarting"].includes(state ?? "");

/** A worker version above the gateway's (unknown or unparsable versions are not "ahead"). */
export function versionAhead(version: string, current: string): boolean {
  try {
    return !!version && compareVersions(version, current) > 0;
  } catch {
    return false;
  }
}
