import { useEffect, useState } from "react";
import { AccessibilityInfo, Easing } from "react-native";
import { motion } from "@canopy/ui";

export const smoothOut = Easing.bezier(...motion.smoothOut);

/** The system's reduce-motion setting, kept live: overlays then fade only, without sliding. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
