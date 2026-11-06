import { useEffect, useState } from "react";
import { Animated, Pressable } from "react-native";
import { motion } from "@canopy/ui";
import { smoothOut, useReducedMotion } from "./motion";
import { useColors } from "./theme";

/**
 * Web: Switch. 44 × 24 dp on phones: a zinc-200 (white/5) track turns brand when on; the white thumb travels on the
 * fast token, without motion under reduced motion. The 44 dp row height is the touch target.
 */
export function Switch({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [x] = useState(() => new Animated.Value(value ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      x.setValue(value ? 1 : 0);

      return;
    }

    const animation = Animated.timing(x, {
      toValue: value ? 1 : 0,
      duration: motion.fast,
      easing: smoothOut,
      useNativeDriver: true,
    });

    animation.start();

    return () => animation.stop();
  }, [value, reduced, x]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={10}
      style={{
        width: 44,
        height: 24,
        // The 1 dp ring and 1 dp padding leave 40 dp inside: a 20 dp thumb travelling 20 dp (web: p-0.5 inset-ring).
        padding: 1,
        borderRadius: 12,
        backgroundColor: value ? c.brand : c.track,
        borderWidth: 1,
        borderColor: c.dark ? "#ffffff1a" : "#18181b0d",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Animated.View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: value ? c.onControl : "#ffffff",
          borderWidth: 1,
          borderColor: "#18181b0d",
          shadowColor: "#000000",
          shadowOpacity: 0.08,
          shadowRadius: 1,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
        }}
      />
    </Pressable>
  );
}
