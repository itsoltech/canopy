import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo";

interface BatteryModule {
  isLowPowerModeEnabledAsync(): Promise<boolean>;
  addListener(
    event: "Expo.powerModeDidChange",
    listener: (event: { lowPowerMode: boolean }) => void,
  ): EventSubscription;
}

/** Optional SDK module: an existing binary without ExpoBattery needs no native rebuild. */
const battery = requireOptionalNativeModule<BatteryModule>("ExpoBattery");

export function useLowPowerMode() {
  const [lowPower, setLowPower] = useState(Boolean(battery));

  useEffect(() => {
    if (!battery) return;
    let mounted = true;

    const refresh = () => {
      void battery
        .isLowPowerModeEnabledAsync()
        .then((value) => {
          if (mounted) setLowPower(value);
        })
        .catch(() => {});
    };

    refresh();
    const power = battery.addListener("Expo.powerModeDidChange", ({ lowPowerMode }) => setLowPower(lowPowerMode));

    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });

    return () => {
      mounted = false;
      power.remove();
      app.remove();
    };
  }, []);

  return lowPower;
}
