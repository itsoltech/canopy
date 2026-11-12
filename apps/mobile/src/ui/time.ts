import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
let subscription: ReturnType<typeof AppState.addEventListener> | undefined;

function publish() {
  now = Date.now();

  for (const listener of listeners) listener();
}

function activeChanged() {
  clearInterval(timer);
  timer = undefined;

  if (AppState.currentState !== "active") return;
  publish();
  timer = setInterval(publish, 1000);
}

function subscribe(update: () => void) {
  listeners.add(update);

  if (!subscription) {
    subscription = AppState.addEventListener("change", activeChanged);
    activeChanged();
  }

  return () => {
    listeners.delete(update);

    if (listeners.size) return;
    clearInterval(timer);
    timer = undefined;
    subscription?.remove();
    subscription = undefined;
  };
}

const idleSubscribe = () => () => {};
const snapshot = () => now;

/** One foreground clock, subscribed only by mounted live text, never by the list or work fold. */
export function useLiveTime(active: boolean) {
  return useSyncExternalStore(active ? subscribe : idleSubscribe, snapshot);
}

/** Select the displayed value from the same clock: unchanged labels do not cause a React render. */
export function useTimeLabel(format: (now: number) => string, active: boolean) {
  return useSyncExternalStore(active ? subscribe : idleSubscribe, () => format(Date.now()));
}
