import { useLayoutEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, FeDropShadow, Filter, G, Path } from "react-native-svg";
import type { AgentPreviewCursor } from "@canopy/contracts";
import { agentCursor } from "@canopy/ui/agent-cursor";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";

/** One displayed window. Keep the animated point in image coordinates, including during layout changes. */
export function PreviewCursor({
  cursor,
  loaded,
  width,
  height,
}: {
  cursor?: AgentPreviewCursor;
  loaded: boolean;
  width: number;
  height: number;
}) {
  const reduced = useReducedMotion();
  const painted = useRef(false);
  const lastAction = useRef("");
  const previous = useRef<AgentPreviewCursor>(undefined);
  const position = useSharedValue({ x: 0, y: 0 });
  const clickAt = useSharedValue<{ actionId: string; x: number; y: number } | null>(null);
  const flashed = useSharedValue("");
  const visible = useSharedValue(0);
  const pulse = useSharedValue(1);

  useAnimatedReaction(
    () => {
      const click = clickAt.get();
      const point = position.get();

      return click && point.x === click.x && point.y === click.y ? click.actionId : "";
    },
    (arrived) => {
      if (!arrived || arrived === flashed.get()) return;
      flashed.set(arrived);
      pulse.set(0);
      pulse.set(withTiming(1, { duration: motion.medium, reduceMotion: ReduceMotion.Never }));
    },
  );

  useLayoutEffect(() => {
    if (!loaded) return;
    const from = previous.current;
    const first = !painted.current;
    painted.current = true;
    previous.current = cursor;

    if (!cursor) {
      visible.set(0);
      clickAt.set(null);
      pulse.set(1);

      return;
    }

    const moved = from && (from.x !== cursor.x || from.y !== cursor.y);
    const point = { x: cursor.x, y: cursor.y };

    if (!from || moved || reduced) {
      position.set(moved && !reduced ? withTiming(point, { duration: motion.fast, easing: smoothOut }) : point);
    }

    if (!from || cursor.actionId !== lastAction.current) {
      pulse.set(1);
      const fresh = !first && cursor.click && cursor.actionId !== lastAction.current;
      clickAt.set(fresh ? { ...point, actionId: cursor.actionId } : null);
    }

    visible.set(1);
    lastAction.current = cursor.actionId;
  }, [cursor, loaded, reduced, position, clickAt, pulse, visible]);

  const marker = useAnimatedStyle(() => ({
    opacity: visible.get(),
    transform: [{ translateX: position.get().x * width }, { translateY: position.get().y * height }],
  }));

  const ring = useAnimatedStyle(() => ({
    opacity: 1 - pulse.get(),
    transform: [{ scale: reduced ? 1 : 0.35 + 0.65 * pulse.get() }],
  }));

  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Animated.View style={[styles.marker, marker]}>
        <Animated.View style={[styles.ring, ring]} />
        <CursorArrow />
      </Animated.View>
    </View>
  );
}

function CursorArrow() {
  const { path, rim, rimStroke, fill, fillStroke, shadow } = agentCursor;

  return (
    <Svg width={68} height={72} viewBox="-16 -16 68 72" style={styles.arrow}>
      <Defs>
        <Filter id="cursor-shadow" x={-16} y={-16} width={68} height={72} filterUnits="userSpaceOnUse">
          <FeDropShadow
            dx={shadow.x}
            dy={shadow.y}
            stdDeviation={shadow.blur}
            floodColor="black"
            floodOpacity={shadow.opacity}
          />
        </Filter>
      </Defs>
      <G filter="url(#cursor-shadow)" strokeLinejoin="round">
        <Path d={path} fill={rim} stroke={rim} strokeWidth={rimStroke} />
        <Path d={path} fill={fill} stroke={fill} strokeWidth={fillStroke} />
      </G>
    </Svg>
  );
}

const styles = StyleSheet.create({
  marker: { position: "absolute", left: 0, top: 0 },
  arrow: { left: -16, top: -16 },
  ring: {
    position: "absolute",
    width: 28,
    height: 28,
    top: -14,
    left: -14,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: agentCursor.fill,
    boxShadow: "0 0 0 1px white",
  },
});
