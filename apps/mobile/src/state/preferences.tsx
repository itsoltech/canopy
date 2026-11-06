import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { WorkFoldPreferences } from "@canopy/domain/work-fold";
import {
  deviceDefaults,
  loadPreferences,
  savePreferences,
  type DeviceKey,
  type DeviceValues,
} from "../storage/preferences";

function usePreferencesState() {
  const [values, setValues] = useState<DeviceValues>(deviceDefaults);

  useEffect(() => {
    let active = true;

    void loadPreferences()
      .then((loaded) => {
        if (active) setValues(loaded);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  const workFold: WorkFoldPreferences = {
    expandWhileWorking: values.workWhileWorking === "expanded",
    keepAfterTurn: values.workAfterTurn === "keep-open",
  };

  return {
    values,
    workFold,
    set<K extends DeviceKey>(key: K, value: DeviceValues[K]) {
      setValues((current) => {
        const next = { ...current, [key]: value };

        // Unwritable storage keeps the choice for this session.
        void savePreferences(next).catch(() => undefined);

        return next;
      });
    },
  };
}

const Context = createContext<ReturnType<typeof usePreferencesState> | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={usePreferencesState()}>{children}</Context.Provider>;
}

export function useDevicePreferences() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing PreferencesProvider");

  return value;
}
