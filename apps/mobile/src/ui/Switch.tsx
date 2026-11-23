import { useEffect, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { motion } from "@canopy/ui";
import { smoothOut, useReducedMotion } from "./motion";
import { useColors } from "./theme";
import { useMinimumTouchTarget } from "./density";

/**
 * Web: Switch. 44 × 24 dp on phones: a zinc-200 (white/5) track turns brand when on; the white thumb travels on the
 * fast token, without motion under reduced motion. `sm` uses 32 × 18 dp with a 48 dp touch target.
 */
export function Switch({
  label,
  value,
  onChange,
  disabled,
  mixed = false,
  size = "md",
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  mixed?: boolean;
  size?: "md" | "sm";
}) {
  const c = useColors();
  const touchTarget = useMinimumTouchTarget();
  const reduced = useReducedMotion();
  const width = size === "sm" ? 32 : 44;
  const height = size === "sm" ? 18 : 24;
  const thumb = height - 4;
  const travel = width - height;
  const position = mixed ? 0.5 : value ? 1 : 0;
  const [x] = useState(() => new Animated.Value(position));

  useEffect(() => {
    if (reduced) {
      x.setValue(position);

      return;
    }

    const animation = Animated.timing(x, {
      toValue: position,
      duration: motion.fast,
      easing: smoothOut,
      useNativeDriver: true,
    });

    animation.start();

    return () => animation.stop();
  }, [position, reduced, x]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: mixed ? "mixed" : value, disabled }}
      disabled={disabled}
      onPress={() => onChange(mixed || !value)}
      hitSlop={
        size === "sm"
          ? {
              top: (Math.max(48, touchTarget) - height) / 2,
              bottom: (Math.max(48, touchTarget) - height) / 2,
              left: (Math.max(48, touchTarget) - width) / 2,
              right: (Math.max(48, touchTarget) - width) / 2,
            }
          : Math.max(10, (touchTarget - height) / 2)
      }
      style={{
        width,
        height,
        // The ring and padding each take 1 dp on either side (web: p-0.5 inset-ring).
        padding: 1,
        borderRadius: height / 2,
        backgroundColor: mixed ? `${c.brand}59` : value ? c.brand : c.track,
        borderWidth: 1,
        borderColor: c.dark ? "#ffffff1a" : "#18181b0d",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Animated.View
        style={{
          width: thumb,
          height: thumb,
          borderRadius: thumb / 2,
          backgroundColor: value && !mixed ? c.onControl : "#ffffff",
          justifyContent: "center",
          alignItems: "center",
          borderWidth: 1,
          borderColor: "#18181b0d",
          shadowColor: "#000000",
          shadowOpacity: 0.08,
          shadowRadius: 1,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }],
        }}
      >
        {mixed && <View style={{ width: 6, height: 1, backgroundColor: c.faint }} />}
      </Animated.View>
    </Pressable>
  );
}
