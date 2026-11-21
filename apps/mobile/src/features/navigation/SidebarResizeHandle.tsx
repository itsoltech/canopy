import { StyleSheet, View } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useColors } from "../../ui/theme";

const TARGET_SIZE = 48;
const DRAG_THRESHOLD = 5;
const ACCESSIBILITY_STEP = 16;

export function SidebarResizeHandle({
  edge,
  size,
  value,
  min,
  max,
  onResize,
}: {
  edge: SharedValue<number>;
  size: SharedValue<number>;
  value: number;
  min: number;
  max: number;
  /** Save a committed width, or 0 to restore the default. */
  onResize: (width: number) => void;
}) {
  const c = useColors();
  const startWidth = useSharedValue(value);
  const dragging = useSharedValue(false);

  const clampWidth = (width: number) => {
    "worklet";

    return Math.min(max, Math.max(min, Math.round(width)));
  };

  const drag = usePanGesture({
    activeOffsetX: [-DRAG_THRESHOLD, DRAG_THRESHOLD],
    failOffsetY: [-12, 12],
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      startWidth.set(size.get());
      dragging.set(true);
    },
    onUpdate: ({ translationX }) => {
      "worklet";
      size.set(clampWidth(startWidth.get() + translationX));
    },
    onDeactivate: ({ canceled }) => {
      "worklet";
      dragging.set(false);

      if (canceled) size.set(value);
      else if (size.get() !== startWidth.get()) scheduleOnRN(onResize, size.get());
    },
  });

  const reset = useTapGesture({
    numberOfTaps: 2,
    maxDistance: DRAG_THRESHOLD,
    onActivate: () => {
      "worklet";
      scheduleOnRN(onResize, 0);
    },
  });

  const gesture = useCompetingGestures(drag, reset);
  const target = useAnimatedStyle(() => ({ left: edge.get() - TARGET_SIZE / 2 }));
  const grip = useAnimatedStyle(() => ({ backgroundColor: dragging.get() ? c.accent : c.muted }));

  return (
    <Animated.View pointerEvents="box-none" style={[styles.target, target]}>
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Resize sidebar"
          accessibilityValue={{ min, max, now: value }}
          accessibilityActions={[
            { name: "increment" },
            { name: "decrement" },
            { name: "reset", label: "Restore default width" },
          ]}
          onAccessibilityAction={({ nativeEvent: { actionName } }) => {
            if (actionName === "reset") onResize(0);
            else if (actionName === "increment" || actionName === "decrement") {
              const next = clampWidth(value + (actionName === "increment" ? ACCESSIBILITY_STEP : -ACCESSIBILITY_STEP));

              if (next !== value) onResize(next);
            }
          }}
          style={styles.touchArea}
        >
          <Animated.View pointerEvents="none" style={[styles.grip, grip]} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  target: {
    position: "absolute",
    zIndex: 1,
    top: "50%",
    marginTop: -TARGET_SIZE / 2,
    width: TARGET_SIZE,
    height: TARGET_SIZE,
  },
  touchArea: { flex: 1, alignItems: "center", justifyContent: "center" },
  grip: { width: 4, height: 28, borderRadius: 2 },
});
