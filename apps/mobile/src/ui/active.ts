import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

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

/** Animation loops and clocks stop while the app is inactive or backgrounded. */
export function useAppActive() {
  return useSyncExternalStore(subscribe, () => AppState.currentState === "active");
}
