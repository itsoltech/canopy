import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import type { View, StyleProp, ViewStyle } from "react-native";
import Animated, {
  measure,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { VisibilityScope } from "../../ui/viewport";

/**
 * Lazily mount once, then retain the measured body through reversals and closing. Once open it uses natural
 * height, so streaming and nested disclosures do not trigger a JS measurement on every animation frame.
 */
export function TimelineDisclosure({
  open,
  children,
  style,
}: {
  open: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [measured, setMeasured] = useState(false);
  const body = useAnimatedRef<View>();
  const height = useSharedValue(0);
  const natural = useSharedValue(open);
  const expanded = useSharedValue(open);

  if (open && !mounted) setMounted(true);

  const animate = useCallback(
    (next: boolean, size: number) => {
      "worklet";
      expanded.set(next);

      if (natural.get()) height.set(size);
      natural.set(false);
      height.set(
        withTiming(next ? size : 0, { duration: reduced ? 0 : motion.fast, easing: smoothOut }, (finished) => {
          if (finished) natural.set(expanded.get());
        }),
      );
    },
    [expanded, height, natural, reduced],
  );

  useLayoutEffect(() => {
    scheduleOnUI(() => {
      expanded.set(open);
      const box = measure(body);

      // The first lazy mount is measured by onLayout; subsequent toggles measure synchronously on UI.
      if (box) animate(open, box.height);
    });
  }, [open, body, expanded, animate]);

  const animated = useAnimatedStyle(() => ({ height: natural.get() ? "auto" : height.get() }));

  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[{ overflow: "hidden" }, animated]}
    >
      {mounted && (
        <Animated.View
          ref={body}
          collapsable={false}
          onLayout={
            measured
              ? undefined
              : (event) => {
                  const size = event.nativeEvent.layout.height;
                  setMeasured(true);
                  scheduleOnUI(() => animate(expanded.get(), size));
                }
          }
          style={[{ flexShrink: 0 }, style]}
        >
          <VisibilityScope visible={open}>{children}</VisibilityScope>
        </Animated.View>
      )}
    </Animated.View>
  );
}
