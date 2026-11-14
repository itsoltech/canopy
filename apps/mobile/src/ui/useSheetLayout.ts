import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnimatedStyle, useDerivedValue, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useKeyboardFrame } from "./KeyboardWindow";

/** Entrance travel and drag offset have independent lifetimes; content keeps its top at either resting position. */
export function useSheetLayout(progress: SharedValue<number>, wide: boolean, fullHeight: boolean, snap: boolean) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const keyboard = useKeyboardFrame();
  const sheetHeight = useSharedValue(height);
  const offset = useSharedValue(0);

  const maximum = useDerivedValue(() =>
    Math.max(0, (height + keyboard.height.get() - insets.top) * (fullHeight ? 0.94 : wide ? 0.7 : 0.85)),
  );

  const padding = useDerivedValue(() => 8 + (wide ? 0 : insets.bottom * (1 - keyboard.progress.get())));

  const travel = useDerivedValue(() =>
    Math.max(1, (wide ? (height + sheetHeight.get()) / 2 : sheetHeight.get()) - keyboard.height.get() + 24),
  );

  const scrim = useAnimatedStyle(() => ({ opacity: Math.max(0, Math.min(1, progress.get())) }));

  const viewport = useAnimatedStyle(() => ({
    paddingBottom: wide ? Math.max(-keyboard.height.get(), insets.bottom) : -keyboard.height.get(),
  }));

  const surface = useAnimatedStyle(() => ({
    maxHeight: maximum.get(),
    height: fullHeight ? maximum.get() : undefined,
    paddingBottom: padding.get(),
    transform: [{ translateY: (1 - progress.get()) * travel.get() + progress.get() * offset.get() }],
  }));

  // Only the scroll viewport's bottom moves. The full surface remains the stable measurement for gestures.
  const body = useAnimatedStyle(() =>
    snap && !wide
      ? { height: Math.max(0, maximum.get() - Math.max(0, offset.get()) - padding.get()) }
      : { flex: fullHeight ? 1 : undefined },
  );

  return { width, height, insets, sheetHeight, offset, travel, scrim, viewport, surface, body };
}
