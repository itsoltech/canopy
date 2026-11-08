import type { ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useKeyboardFrame } from "./KeyboardWindow";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { motion, useReducedMotion } from "./motion";
import { useColors } from "./theme";

/** The scrim fills the window independently of keyboard padding. Phone sheets never scale away from its edges. */
export function OverlaySurface({
  visible,
  onClose,
  label,
  progress,
  wide,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  label: string;
  progress: SharedValue<number>;
  wide: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const keyboard = useKeyboardFrame();
  const shift = reduced || wide ? 0 : motion.distance.large;
  const grow = reduced || !wide ? 1 : motion.scale.large;
  const scrim = useAnimatedStyle(() => ({ opacity: progress.get() }));

  const viewport = useAnimatedStyle(() => ({
    paddingBottom: wide ? Math.max(-keyboard.height.get(), insets.bottom) : -keyboard.height.get(),
  }));

  const surface = useAnimatedStyle(() => {
    const t = progress.get();
    const available = height + keyboard.height.get() - insets.top;

    return {
      opacity: t,
      maxHeight: Math.max(0, available * (wide ? 0.7 : 0.85)),
      paddingBottom: 8 + (wide ? 0 : insets.bottom * (1 - keyboard.progress.get())),
      transform: [{ translateY: (1 - t) * shift }, { scale: grow + (1 - grow) * t }],
    };
  });

  return (
    <View pointerEvents={visible ? "auto" : "none"} style={{ flex: 1 }}>
      <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }, scrim]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${label}`}
          onPress={onClose}
          style={{ flex: 1, backgroundColor: c.scrim }}
        />
      </Animated.View>
      <Animated.View
        pointerEvents="box-none"
        style={[
          {
            flex: 1,
            paddingTop: insets.top,
            paddingLeft: wide ? insets.left : 0,
            paddingRight: wide ? insets.right : 0,
            justifyContent: wide ? "center" : "flex-end",
            alignItems: "center",
          },
          viewport,
        ]}
      >
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={label}
          style={[
            {
              width: wide ? Math.min(420, width - insets.left - insets.right - 48) : "100%",
              marginHorizontal: wide ? 24 : 0,
              paddingLeft: wide ? 0 : insets.left,
              paddingRight: wide ? 0 : insets.right,
              borderRadius: 16,
              borderBottomLeftRadius: wide ? 16 : 0,
              borderBottomRightRadius: wide ? 16 : 0,
              backgroundColor: c.overlay,
              borderWidth: c.dark ? 1 : 0,
              borderBottomWidth: wide && c.dark ? 1 : 0,
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
      </Animated.View>
    </View>
  );
}
