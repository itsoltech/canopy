import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useVisibility } from "./viewport";

const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AppState.addEventListener> | undefined;

function subscribe(update: () => void) {
  listeners.add(update);
  subscription ??= AppState.addEventListener("change", () => {
    for (const listener of listeners) listener();
  });

  return () => {
    listeners.delete(update);

    if (listeners.size) return;
    subscription?.remove();
    subscription = undefined;
  };
}

/** Animation loops and timers stop while the app is inactive or their retained screen is covered. */
export function useAppActive() {
  const visible = useVisibility();
  const active = useSyncExternalStore(subscribe, () => AppState.currentState === "active");

  return active && visible;
}
