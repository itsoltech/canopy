import { File, Paths } from "expo-file-system";

/**
 * Preferences of this phone only (the web keeps the same ones per browser). Values are strings at the storage
 * boundary; only declared choices are accepted, anything else falls back to the default.
 */
export const deviceChoices = {
  workWhileWorking: ["expanded", "collapsed"],
  workAfterTurn: ["collapse", "keep-open"],
  workToolCalls: ["collapsed", "expanded"],
} as const;

export type DeviceKey = keyof typeof deviceChoices;

export type DeviceValues = { [K in DeviceKey]: (typeof deviceChoices)[K][number] };

export const deviceDefaults: DeviceValues = {
  workWhileWorking: "expanded",
  workAfterTurn: "collapse",
  workToolCalls: "collapsed",
};

const file = () => new File(Paths.document, "device-preferences.json");

function isChoice<K extends DeviceKey>(key: K, value: unknown): value is DeviceValues[K] {
  return deviceChoices[key].some((choice) => choice === value);
}

/** The stored file: any field may be missing or hold an unknown value. */
interface StoredPreferences {
  workWhileWorking?: unknown;
  workAfterTurn?: unknown;
  workToolCalls?: unknown;
}

function isStored(value: unknown): value is StoredPreferences {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(raw: string): DeviceValues {
  let stored: unknown;

  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...deviceDefaults };
  }

  const saved: StoredPreferences = isStored(stored) ? stored : {};

  return {
    workWhileWorking: isChoice("workWhileWorking", saved.workWhileWorking)
      ? saved.workWhileWorking
      : deviceDefaults.workWhileWorking,
    workAfterTurn: isChoice("workAfterTurn", saved.workAfterTurn) ? saved.workAfterTurn : deviceDefaults.workAfterTurn,
    workToolCalls: isChoice("workToolCalls", saved.workToolCalls) ? saved.workToolCalls : deviceDefaults.workToolCalls,
  };
}

export async function loadPreferences(): Promise<DeviceValues> {
  const stored = file();

  if (!stored.exists) return { ...deviceDefaults };

  return parse(await stored.text());
}

export async function savePreferences(values: DeviceValues) {
  const stored = file();

  if (!stored.exists) stored.create();
  await stored.write(JSON.stringify(values));
}
