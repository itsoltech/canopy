import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { DeviceViewPreferences, deviceViewDefaults, type DeviceViewValues } from "@canopy/domain/device-view";
import { mobileFontFamilies } from "./mobile-fonts";
import { useSession } from "../../state/session";
import { loadDeviceView, saveDeviceView } from "../../storage/device-view";

// Device preferences never enter account settings or overwrite another client's choices.
export const deviceChoices = {
  attachmentMarkdown: ["rendered", "source"],
  inAppNotifications: ["on", "off"],
  timeFormat: ["system", "12h", "24h"],
  contrast: ["standard", "strong", "maximum"],
  effortDisplay: ["name", "bars"],
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
  showFinishedSubagents: ["off", "on"],
  subagentsExpanded: ["off", "on"],
  finishedSubagentsExpanded: ["off", "on"],
} as const;

export type DeviceKey = keyof typeof deviceChoices;

export const deviceDefaults: Record<DeviceKey, string> = {
  attachmentMarkdown: "rendered",
  inAppNotifications: "on",
  timeFormat: "system",
  contrast: "standard",
  effortDisplay: "name",
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
  showFinishedSubagents: "off",
  subagentsExpanded: "off",
  finishedSubagentsExpanded: "off",
};

export const appearanceDeviceKeys: DeviceKey[] = [
  "contrast",
  "effortDisplay",
  "interfaceFont",
  "interfaceSize",
  "monoFont",
  "monoSize",
  "wrapCode",
  "wrapDiffs",
];

export const diffDeviceKeys: DeviceKey[] = ["diffLayout", "hideWhitespace", "diffFileState", "diffColors"];
const storageKey = "canopy.settings.preferences.v1";

function deviceViewStore(scope: string, changed: (values: DeviceViewValues) => void, failed: (error: string) => void) {
  let writes = Promise.resolve();

  return new DeviceViewPreferences(changed, (raw) => {
    writes = writes
      .catch(() => {})
      .then(() => saveDeviceView(scope, raw))
      .then(() => failed(""))
      .catch(() => failed("Could not save device preferences. Choose the setting again to retry."));
  });
}

function useDeviceView(scope: string) {
  const [view, setView] = useState({ ...deviceViewDefaults });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [store] = useState(() => deviceViewStore(scope, setView, setError));

  useEffect(() => {
    let active = true;
    void loadDeviceView(scope)
      .then((raw) => {
        if (active) store.load(raw);
      })
      .catch(() => {
        if (active) setError("Could not load device preferences. Restore device defaults to retry.");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, [store, scope]);

  return {
    view,
    viewLoaded: loaded,
    viewError: error,
    initializeView(legacy: Partial<DeviceViewValues>) {
      if (loaded) store.initialize(legacy);
    },
    setView(change: Partial<DeviceViewValues>) {
      if (loaded) store.set(change);
    },
  };
}

const isKey = (key: string): key is DeviceKey => Object.hasOwn(deviceChoices, key);

function validChoice(key: DeviceKey, value: string): boolean {
  if (key === "interfaceFont" || key === "monoFont") {
    const local = mobileFontFamilies.find((font) => value === `local:${font.family}`);

    if (local && (key !== "monoFont" || local.mono)) return true;
  }

  return deviceChoices[key].some((option) => option === value);
}

function isSavedPreferences(value: unknown): value is Partial<Record<DeviceKey, string>> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).every(
      ([key, choice]) =>
        isKey(key) &&
        (deviceChoices[key].some((option) => option === choice) ||
          ((key === "interfaceFont" || key === "monoFont") &&
            mobileFontFamilies.some((font) => choice === `local:${font.family}` && (key !== "monoFont" || font.mono)))),
    )
  );
}

function readPreferences(raw: string | null): Record<DeviceKey, string> {
  const result = { ...deviceDefaults };

  if (!raw) return result;
  const entries: unknown = JSON.parse(raw);

  if (!isSavedPreferences(entries)) return result;

  for (const [key, value] of Object.entries(entries)) {
    if (isKey(key) && value !== undefined && validChoice(key, value)) result[key] = value;
  }

  return result;
}

function useDeviceState(scope: string) {
  const view = useDeviceView(scope);
  const [values, setValues] = useState({ ...deviceDefaults });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const writes = useRef(Promise.resolve());
  const current = useRef(values);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
      .then((raw) => {
        if (active) {
          current.current = readPreferences(raw);
          setValues(current.current);
        }
      })
      .catch(() => {
        if (active) setError("Could not load device preferences. Restore device defaults to retry.");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  function save(next: Record<DeviceKey, string>) {
    current.current = next;
    setValues(next);
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        try {
          await SecureStore.setItemAsync(storageKey, JSON.stringify(next));
          setError("");
        } catch {
          setError("Could not save device preferences. Choose the setting again to retry.");
        }
      });
  }

  return {
    ...view,
    values,
    loaded,
    error: error || view.viewError,
    set(key: DeviceKey, value: string) {
      if (loaded && validChoice(key, value)) save({ ...current.current, [key]: value });
    },
    reset(keys: readonly DeviceKey[]) {
      if (!loaded) return;
      const next = { ...current.current };

      for (const key of keys) next[key] = deviceDefaults[key];
      save(next);
    },
  };
}

const Context = createContext<ReturnType<typeof useDeviceState> | null>(null);

export function DevicePreferencesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const scope = session ? `${session.fingerprint}.${session.deviceId}` : "unpaired";

  return (
    <DevicePreferencesSession key={scope} scope={scope}>
      {children}
    </DevicePreferencesSession>
  );
}

function DevicePreferencesSession({ children, scope }: { children: ReactNode; scope: string }) {
  return <Context.Provider value={useDeviceState(scope)}>{children}</Context.Provider>;
}

export function useDevicePreferences() {
  const state = useContext(Context);

  if (!state) throw new Error("Missing DevicePreferencesProvider");

  return state;
}
