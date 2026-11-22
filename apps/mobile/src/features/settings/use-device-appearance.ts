import { useCallback, useEffect, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { deviceAppearanceDefaults, legacyDeviceAppearance, type DeviceAppearance } from "@canopy/domain";
import { loadDeviceAppearance, saveDeviceAppearance } from "../../storage/device-appearance";

export function useDeviceAppearance() {
  const [values, setValues] = useState(deviceAppearanceDefaults);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const current = useRef<DeviceAppearance | undefined>(undefined);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    void loadDeviceAppearance().then(
      (stored) => {
        if (!active) return;
        current.current = stored;
        setValues(stored ?? deviceAppearanceDefaults);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("failed");
      },
    );

    return () => {
      active = false;
    };
  }, [attempt]);

  const save = useCallback((next: DeviceAppearance) => {
    current.current = next;
    setValues(next);
    writes.current = writes.current
      .then(() => saveDeviceAppearance(next))
      .then(
        () => setSaveFailed(false),
        () => setSaveFailed(true),
      );
  }, []);

  const initialize = useCallback(
    (legacy: ui.AppearanceSettings | undefined) => {
      if (status === "ready" && !current.current) save(legacyDeviceAppearance(legacy));
    },
    [save, status],
  );

  return {
    values,
    initialize,
    loading: status === "loading",
    editable: status === "ready",
    error:
      status === "failed"
        ? "Could not load appearance settings."
        : saveFailed
          ? "Could not save appearance settings."
          : "",
    update(change: Partial<DeviceAppearance>) {
      if (status === "ready") save({ ...(current.current ?? deviceAppearanceDefaults), ...change });
    },
    reset() {
      if (status === "ready") save({ ...deviceAppearanceDefaults });
    },
    retry() {
      if (status === "failed") setAttempt((value) => value + 1);
      else if (current.current) save(current.current);
    },
  };
}
