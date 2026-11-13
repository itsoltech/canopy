import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";
import { useAppActive } from "./active";
import { whileForeground } from "../state/foreground-work";

/** Remove the timer while covered or suspended; a retained screen never polls just because it is mounted. */
export function useForegroundInterval(tick: () => void, delay: number, enabled = true) {
  const active = useAppActive();

  const run = useEffectEvent(() => {
    if (AppState.currentState === "active") tick();
  });

  useEffect(() => {
    if (!active || !enabled) return;

    return whileForeground(AppState, () => {
      const timer = setInterval(run, delay);

      return () => clearInterval(timer);
    });
  }, [active, enabled, delay]);
}
