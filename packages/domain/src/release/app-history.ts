import { DeviceViewPreferences } from "../device-view.ts";
import { appVersionIncreased } from "./note-range.ts";
import { releaseChannel } from "./version.ts";

/** Uses the client-local preference store, under a separate app scope (never account or linked-computer state). */
export class AppUpdateHistory {
  readonly preferences: DeviceViewPreferences;
  constructor(persist: (raw: string) => void) {
    this.preferences = new DeviceViewPreferences(() => {}, persist);
  }

  load(raw: string | null): void {
    this.preferences.load(raw);
  }

  /** Remember the actual from/to pair for later visits, including after dismissal. */
  get range(): { from: string; to: string } | undefined {
    const { appUpdateFrom: from, lastSeenAppVersion: to } = this.preferences.values;

    return appVersionIncreased(from, to) ? { from, to } : undefined;
  }

  /** First install and unknown previous builds establish a baseline without a launch notice. */
  observe(current: string): boolean {
    if (releaseChannel(current) === "development") return false;
    const previous = this.preferences.values.lastSeenAppVersion;

    if (previous === current) return false;
    const increased = appVersionIncreased(previous, current);
    this.preferences.set({ lastSeenAppVersion: current, appUpdateFrom: increased ? previous : "" });

    return increased;
  }
}
