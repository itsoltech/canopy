import { useCallback, type ReactNode } from "react";
import { useFocusEffect } from "expo-router";
import { useWindowDimensions } from "react-native";
import Animated, {
  measure,
  useAnimatedRef,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useContentInsets } from "../../ui/ScreenFrame";
import { useKeyboardFrame } from "../../ui/KeyboardWindow";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { useComposerMotion } from "./ComposerFold";

/** Measure the entire visible stack, including trays and the footer, on the UI thread.
 * Native insets extend the scroll range without relaying animation frames through React or laying out rows.
 * Keyboard scroll views already own the safe area, so subtract it here rather than reserving it twice. */
export function ComposerCoverage({
  children,
  value,
  fade,
}: {
  children: ReactNode;
  value?: SharedValue<number>;
  fade?: ReactNode;
}) {
  const stack = useAnimatedRef<Animated.View>();
  const insets = useContentInsets();
  const safe = insets.bottom;
  const viewport = useWindowDimensions().height;
  const keyboard = useKeyboardFrame();
  const reduced = useReducedMotion();
  const { progress, writing } = useComposerMotion();
  const previousFold = useSharedValue(progress.get());
  const previousWriting = useSharedValue(writing.get());
  const natural = useSharedValue(0);
  const height = useSharedValue((value?.get() ?? 0) + safe);
  const size = useAnimatedStyle(() => (value ? { height: height.get() } : {}));

  const bounds = useAnimatedStyle(() =>
    value ? { maxHeight: Math.max(80, viewport + keyboard.height.get() - insets.top - 96) } : {},
  );

  useAnimatedReaction(
    () => height.get(),
    (next) => {
      if (value) value.set(Math.max(0, next - safe));
    },
  );

  const frames = useFrameCallback(() => {
    "worklet";

    if (!value) return;
    const box = measure(stack);
    const folding = previousFold.get() !== progress.get() || previousWriting.get() !== writing.get();
    previousFold.set(progress.get());
    previousWriting.set(writing.get());

    if (box) {
      if (Math.abs(box.height - natural.get()) >= 0.25) {
        const first = natural.get() === 0;
        natural.set(box.height);
        height.set(
          first || folding || reduced
            ? box.height
            : withTiming(box.height, { duration: motion.fast, easing: smoothOut }),
        );
      }
    }
  }, false);

  useFocusEffect(
    useCallback(() => {
      frames.setActive(Boolean(value));

      return () => frames.setActive(false);
    }, [frames, value]),
  );

  return (
    <Animated.View collapsable={false} pointerEvents="box-none" style={[{ flexShrink: 1, minHeight: 0 }, size]}>
      {value && fade}
      <Animated.View style={value ? { flex: 1, overflow: "hidden" } : undefined}>
        <Animated.View
          ref={stack}
          collapsable={false}
          pointerEvents="box-none"
          style={[value ? { position: "absolute", bottom: 0, left: 0, right: 0 } : undefined, bounds]}
        >
          {children}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
