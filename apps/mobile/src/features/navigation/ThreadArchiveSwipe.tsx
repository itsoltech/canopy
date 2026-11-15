import { useEffect, useMemo, type ReactNode } from "react";
import { PanResponder, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { useThreadActions } from "../threads/useThreadActions";
import { Icon } from "../../ui/Icon";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";

/**
 * A left swipe commits the same archive action as the sheet; short or cancelled swipes return to rest. A committed
 * swipe carries the row off and leaves it there: the gateway's update then removes the row, and its neighbours glide
 * into the gap (the list cell's layout transition). A failed request or a confirmation dialog brings it back.
 */
export function ThreadArchiveSwipe({ thread, children }: { thread: ui.Thread; children: ReactNode }) {
  const c = useColors();
  const actions = useThreadActions(thread);
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  const shown = useSharedValue(1);
  const width = useSharedValue(0);
  const foreground = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateX: offset.get() }] }));
  const reveal = useAnimatedStyle(() => ({ opacity: shown.get() * Math.min(1, -offset.get() / 48) }));

  // The thread stayed in this list after its archive state changed (a filter keeps it): show it again.
  useEffect(() => {
    shown.set(1);
    offset.set(0);
  }, [actions.archived, offset, shown]);

  const handlers = useMemo(() => {
    const timing = (duration: number) => ({ duration, easing: smoothOut });

    const reset = () => {
      shown.set(withTiming(1, timing(motion.fast)));
      offset.set(reduced ? 0 : withTiming(0, timing(motion.quick)));
    };

    // Close on `quick`; with reduced motion the row only fades where it is.
    const leave = () => {
      shown.set(withTiming(0, timing(motion.quick)));

      if (!reduced) offset.set(withTiming(-Math.max(width.get(), 112), timing(motion.quick)));
    };

    const commit = () => {
      const pending = actions.commit("archive");

      if (!pending) return reset();
      leave();
      void pending.then((done) => {
        if (!done) reset();
      });
    };

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
        if (gesture.dx <= -80 && -gesture.dx > Math.abs(gesture.dy) * 1.5 && gesture.vx <= 0) commit();
        else reset();
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true,
    }).panHandlers;
  }, [actions.disabled, actions.busy, actions.commit, offset, shown, width, reduced]);

  return (
    <View
      style={{ overflow: "hidden", borderRadius: 12 }}
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
      {...handlers}
    >
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
