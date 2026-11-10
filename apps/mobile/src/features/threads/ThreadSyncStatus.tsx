import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "../../ui/Icon";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { useAppActive } from "../../ui/active";

/** Reuses the project mark's slot; brief checkpoint refreshes stay invisible and silent. */
export function ThreadSyncStatus({ syncing, children }: { syncing: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const reduced = useReducedMotion();
  const active = useAppActive();
  const opacity = useSharedValue(0);
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (!syncing) {
      setShown(false);

      return;
    }

    const reveal = setTimeout(() => setShown(true), motion.verySlow);
    const announce = setTimeout(() => AccessibilityInfo.announceForAccessibility("Syncing…"), motion.verySlow * 4);

    return () => {
      clearTimeout(reveal);
      clearTimeout(announce);
    };
  }, [syncing]);

  const visible = syncing && shown;

  useEffect(() => {
    opacity.set(
      withTiming(visible ? 1 : 0, {
        duration: motion.quick,
        easing: smoothOut,
        reduceMotion: ReduceMotion.Never,
      }),
    );
    cancelAnimation(rotation);

    if (reduced) rotation.set(0);

    if (active && visible && !reduced) {
      rotation.set(0);
      rotation.set(
        withRepeat(
          withTiming(360, {
            duration: motion.verySlow * 4,
            easing: Easing.linear,
            reduceMotion: ReduceMotion.Never,
          }),
          -1,
          false,
          undefined,
          ReduceMotion.Never,
        ),
      );
    }

    return () => cancelAnimation(rotation);
  }, [visible, reduced, active, opacity, rotation]);

  const markStyle = useAnimatedStyle(() => ({ opacity: 1 - opacity.get() }));

  const iconStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ rotate: `${rotation.get()}deg` }],
  }));

  return (
    <View style={{ width: 18, height: 18 }}>
      <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={markStyle}>
        {children}
      </Animated.View>
      <Animated.View
        accessible={visible}
        accessibilityRole="image"
        accessibilityLabel="Syncing…"
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
        pointerEvents="none"
        style={[{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }, iconStyle]}
      >
        <Icon name="arrow-path" />
      </Animated.View>
    </View>
  );
}
