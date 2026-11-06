import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { motion, smoothOut, useReducedMotion } from "./motion";
import { useColors } from "./theme";
import { useKeyboardOverlap } from "./KeyboardArea";

/** Window width from which overlays open as a centered card instead of a bottom sheet (tablets, unfolded phones). */
export const WIDE_OVERLAY = 600;

/**
 * A compact overlay: a bottom sheet on phones, a centered card on wide windows. The sheet rises from
 * `distance.large` and grows from `scale.large`, opening on `slow` and closing on `medium` (web bottom sheet); the
 * card grows from `scale.large` on `fast` / `quick` (web modal). The scrim fades with it. With reduced motion it
 * only fades.
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
  const progress = useSharedValue(0);
  const [mounted, setMounted] = useState(visible);
  const wide = width >= WIDE_OVERLAY;
  // The sheet sits on the keyboard while it is open; its own bottom inset is then under the keyboard.
  const keyboard = useKeyboardOverlap();

  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (!mounted) return;
    const duration = wide ? (visible ? motion.fast : motion.quick) : visible ? motion.slow : motion.medium;
    progress.set(
      withTiming(visible ? 1 : 0, { duration, easing: smoothOut, reduceMotion: ReduceMotion.Never }, (finished) => {
        if (finished && !visible) scheduleOnRN(setMounted, false);
      }),
    );
  }, [visible, mounted, wide, progress]);

  const shift = reduced || wide ? 0 : motion.distance.large;
  const grow = reduced ? 1 : motion.scale.large;
  const scrim = useAnimatedStyle(() => ({ opacity: progress.get() }));

  const surface = useAnimatedStyle(() => {
    const t = progress.get();

    return {
      opacity: t,
      transform: [{ translateY: (1 - t) * shift }, { scale: grow + (1 - grow) * t }],
    };
  });

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
          paddingTop: wide ? insets.top : 0,
          paddingBottom: wide ? Math.max(keyboard, insets.bottom) : keyboard,
          paddingLeft: wide ? insets.left : 0,
          paddingRight: wide ? insets.right : 0,
          justifyContent: wide ? "center" : "flex-end",
          alignItems: "center",
        }}
      >
        <Animated.View
          style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }, scrim]}
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
          style={[
            {
              width: wide ? Math.min(420, width - insets.left - insets.right - 48) : "100%",
              maxHeight: wide
                ? (height - Math.max(keyboard, insets.bottom) - insets.top) * 0.7
                : (height - keyboard) * 0.85 - insets.top,
              marginHorizontal: wide ? 24 : 0,
              paddingBottom: wide || keyboard ? 8 : insets.bottom + 8,
              paddingLeft: wide ? 0 : insets.left,
              paddingRight: wide ? 0 : insets.right,
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
            },
            surface,
          ]}
        >
          {!wide && (
            <View style={{ alignItems: "center", paddingTop: 8 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.line }} />
            </View>
          )}
          <LayoutAnimationConfig skipEntering skipExiting>
            {children}
          </LayoutAnimationConfig>
        </Animated.View>
      </View>
    </Modal>
  );
}
