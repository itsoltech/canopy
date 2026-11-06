import { toast } from "#lib/shared/ui/toast.svelte.ts";

/** Values are strings at the storage boundary; only declared choices are accepted. */
export const deviceChoices = {
  threadNotifications: ["off", "notifications", "sound"],
  botNotifications: ["off", "notifications", "sound"],
  inAppNotifications: ["on", "off"],
  showFinishedSubagents: ["off", "on"],
  subagentsExpanded: ["off", "on"],
  workWhileWorking: ["expanded", "collapsed"],
  workAfterTurn: ["collapse", "keep-open"],
  timeFormat: ["system", "12h", "24h"],
  contrast: ["standard", "strong", "maximum"],
  effortDisplay: ["name", "bars"],
  renderMath: ["on", "off"],
  interfaceFont: ["canopy", "system", "serif"],
  interfaceSize: ["12", "14", "16", "18"],
  monoFont: ["system", "menlo", "consolas"],
  monoSize: ["12", "13", "14", "16"],
  wrapCode: ["off", "on"],
  wrapDiffs: ["off", "on"],
  diffLayout: ["stacked", "split"],
  hideWhitespace: ["off", "on"],
  diffFileState: ["expanded", "collapsed"],
  diffColors: ["red-green", "blue-orange"],
} as const;

export type DeviceKey = keyof typeof deviceChoices;

export const deviceDefaults: Record<DeviceKey, string> = {
  threadNotifications: "off",
  botNotifications: "off",
  inAppNotifications: "on",
  showFinishedSubagents: "off",
  subagentsExpanded: "off",
  workWhileWorking: "expanded",
  workAfterTurn: "collapse",
  timeFormat: "system",
  contrast: "standard",
  effortDisplay: "name",
  renderMath: "on",
  interfaceFont: "canopy",
  interfaceSize: "14",
  monoFont: "system",
  monoSize: "13",
  wrapCode: "off",
  wrapDiffs: "off",
  diffLayout: "stacked",
  hideWhitespace: "off",
  diffFileState: "expanded",
  diffColors: "red-green",
};

const prefix = "canopy:preferences:";

export class DevicePreferences {
  values = $state<Record<DeviceKey, string>>({ ...deviceDefaults });

  connect(): () => void {
    const read = () => {
      try {
        for (const key of Object.keys(deviceChoices)) {
          if (!isDeviceKey(key)) continue;
          const value = localStorage.getItem(prefix + key);
          this.values[key] = value && validChoice(key, value) ? value : deviceDefaults[key];
        }
      } catch {
        // Private browsing may deny storage. Defaults remain usable in memory.
      }
    };

    read();
    window.addEventListener("storage", read);

    return () => window.removeEventListener("storage", read);
  }

  set(key: DeviceKey, value: string): void {
    if (!validChoice(key, value)) return;
    this.values[key] = value;

    try {
      if (value === deviceDefaults[key]) localStorage.removeItem(prefix + key);
      else localStorage.setItem(prefix + key, value);
    } catch {
      toast("The preference could not be saved. Allow browser storage to keep it after closing this tab.", {
        tone: "error",
      });
    }
  }

  reset(keys: readonly DeviceKey[]): void {
    for (const key of keys) this.set(key, deviceDefaults[key]);
  }
}

function isDeviceKey(key: string): key is DeviceKey {
  return Object.hasOwn(deviceChoices, key);
}

function validChoice(key: DeviceKey, value: string): boolean {
  return deviceChoices[key].some((choice) => choice === value);
}

export const devicePreferences = new DevicePreferences();

export const generalDeviceKeys = [
  "threadNotifications",
  "botNotifications",
  "inAppNotifications",
  "timeFormat",
] as const;

export const appearanceDeviceKeys = [
  "contrast",
  "effortDisplay",
  "renderMath",
  "interfaceFont",
  "interfaceSize",
  "monoFont",
  "monoSize",
  "wrapCode",
  "wrapDiffs",
] as const;

export const diffDeviceKeys = ["diffLayout", "hideWhitespace", "diffFileState", "diffColors"] as const;
