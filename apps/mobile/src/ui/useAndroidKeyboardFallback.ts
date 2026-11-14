import { useEffect } from "react";
import { Keyboard, Platform } from "react-native";
import { useAnimatedReaction, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Reconcile settled Android IME bounds even when its animation callback stream misses a transition. */
export function useAndroidKeyboardFallback(
  height: SharedValue<number>,
  progress: SharedValue<number>,
  moving: SharedValue<boolean>,
) {
  const { bottom } = useSafeAreaInsets();
  const pending = useSharedValue<number | null>(null);

  // Android can report final layout before the IME animation finishes. Let native frames finish first;
  // when no animation stream arrives, the independent layout event still restores the visible bounds.
  useAnimatedReaction(
    () => (moving.get() ? null : pending.get()),
    (next) => {
      if (next === null) return;
      height.set(-next);
      progress.set(next > 0 ? 1 : 0);
      pending.set(null);
    },
  );

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const shown = Keyboard.addListener("keyboardDidShow", (event) => {
      // RN excludes the navigation bar; our translucent KeyboardProvider includes it.
      pending.set(event.endCoordinates.height + bottom);
    });

    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      pending.set(0);
    });

    const metrics = Keyboard.metrics();

    if (Keyboard.isVisible() && metrics) {
      pending.set(metrics.height + bottom);
    }

    return () => {
      shown.remove();
      hidden.remove();
      pending.set(null);
    };
  }, [pending, bottom]);
}
