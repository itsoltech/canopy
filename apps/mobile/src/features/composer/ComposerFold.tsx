import { useEffect, useState, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { motion } from "@canopy/ui";
import { smoothOut, useReducedMotion } from "../../ui/motion";

/** Native counterpart of ComposerFold: keep controls mounted and animate only their height and opacity. */
export function useComposerMotion(open: boolean) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduced ? 0 : open ? motion.slow : motion.medium,
      easing: smoothOut,
      useNativeDriver: false,
    });

    animation.start();

    return () => animation.stop();
  }, [open, progress, reduced]);

  return progress;
}

export function ComposerFold({ open, children }: { open: boolean; children: ReactNode }) {
  const progress = useComposerMotion(open);
  const [height, setHeight] = useState(0);

  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={{ height: Animated.multiply(progress, height), opacity: progress, overflow: "hidden" }}
    >
      <View
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
      >
        {children}
      </View>
    </Animated.View>
  );
}
