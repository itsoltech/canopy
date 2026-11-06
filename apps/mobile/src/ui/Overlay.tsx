import { useEffect, useState, type ReactNode } from "react";
import { Animated, Modal, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { motion } from "@canopy/ui";
import { smoothOut, useReducedMotion } from "./motion";
import { useColors } from "./theme";
import { useKeyboardOverlap } from "./KeyboardArea";

/** Window width from which overlays open as a centered card instead of a bottom sheet (tablets, unfolded phones). */
export const WIDE_OVERLAY = 600;

/**
 * A compact overlay: a bottom sheet on phones, a centered card on wide windows. Opens on the fast token and
 * closes on the quick one; with reduced motion it only fades.
 */
export function Overlay({
  visible,
  onClose,
  label,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  const [mounted, setMounted] = useState(visible);
  const wide = width >= WIDE_OVERLAY;
  // The sheet sits on the keyboard while it is open; its own bottom inset is then under the keyboard.
  const keyboard = useKeyboardOverlap();

  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? motion.fast : motion.quick,
      easing: smoothOut,
      useNativeDriver: true,
    });

    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });

    return () => animation.stop();
  }, [visible, progress]);

  const shift = reduced ? 0 : wide ? 8 : 24;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [shift, 0] });

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          paddingBottom: keyboard,
          justifyContent: wide ? "center" : "flex-end",
          alignItems: "center",
        }}
      >
        <Animated.View
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: progress }}
          pointerEvents={visible ? "auto" : "none"}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${label}`}
            onPress={onClose}
            style={{ flex: 1, backgroundColor: c.scrim }}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={label}
          style={{
            width: wide ? Math.min(420, width - 48) : "100%",
            maxHeight: wide ? (height - keyboard) * 0.7 : (height - keyboard) * 0.85 - insets.top,
            marginHorizontal: wide ? 24 : 0,
            paddingBottom: wide || keyboard ? 8 : insets.bottom + 8,
            borderRadius: 16,
            borderBottomLeftRadius: wide ? 16 : 0,
            borderBottomRightRadius: wide ? 16 : 0,
            backgroundColor: c.overlay,
            borderWidth: c.dark ? 1 : 0,
            borderColor: c.line,
            shadowColor: "#000000",
            shadowOpacity: 0.2,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: 8 },
            elevation: 12,
            opacity: progress,
            transform: [{ translateY }],
          }}
        >
          {!wide && (
            <View style={{ alignItems: "center", paddingTop: 8 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.line }} />
            </View>
          )}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
