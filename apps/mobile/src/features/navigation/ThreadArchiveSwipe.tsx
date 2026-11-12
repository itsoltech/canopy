import { useMemo, type ReactNode } from "react";
import { PanResponder, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { useThreadActions } from "../threads/useThreadActions";
import { Icon } from "../../ui/Icon";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";

/** A left swipe commits the same archive action as the sheet; short or cancelled swipes return to rest. */
export function ThreadArchiveSwipe({ thread, children }: { thread: ui.Thread; children: ReactNode }) {
  const c = useColors();
  const actions = useThreadActions(thread);
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  const foreground = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  const reveal = useAnimatedStyle(() => ({ opacity: Math.min(1, -offset.get() / 48) }));

  const handlers = useMemo(() => {
    const reset = () => offset.set(reduced ? 0 : withTiming(0, { duration: motion.quick, easing: smoothOut }));

    return PanResponder.create({
      // Capture horizontal movement only. Taps, long presses and vertical list scrolling keep their responders.
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        !actions.disabled &&
        !actions.busy &&
        gesture.numberActiveTouches === 1 &&
        gesture.dx < -12 &&
        -gesture.dx > Math.abs(gesture.dy) * 1.5,
      onPanResponderMove: (_, gesture) => offset.set(Math.max(-112, Math.min(0, gesture.dx))),
      onPanResponderRelease: (_, gesture) => {
        reset();

        if (gesture.dx <= -80 && -gesture.dx > Math.abs(gesture.dy) * 1.5 && gesture.vx <= 0) actions.run("archive");
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true,
    }).panHandlers;
  }, [actions.disabled, actions.busy, actions.run, offset, reduced]);

  return (
    <View style={{ overflow: "hidden", borderRadius: 12 }} {...handlers}>
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            inset: 0,
            alignItems: "flex-end",
            justifyContent: "center",
            paddingHorizontal: 16,
            backgroundColor: c.inset,
          },
          reveal,
        ]}
      >
        <View style={[styles.row, { gap: 6 }]}>
          <Icon name={actions.archived ? "arrow-uturn-left" : "archive-box"} size={16} color={c.body} />
          <Text style={[styles.meta, { color: c.body }]}>{actions.archived ? "Unarchive" : "Archive"}</Text>
        </View>
      </Animated.View>
      <Animated.View style={[{ backgroundColor: c.sidebar }, foreground]}>{children}</Animated.View>
    </View>
  );
}
