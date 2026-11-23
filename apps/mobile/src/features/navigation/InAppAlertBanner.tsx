import { Pressable, Text } from "react-native";
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { palette } from "@canopy/ui";
import { usePaneInsets } from "../../ui/ScreenFrame";
import { motion, smoothOut, useMotion, useReducedMotion } from "../../ui/motion";
import { font, styles, useColors } from "../../ui/theme";
import type { InAppAlert } from "./useBotAlerts";

const SWIPE_ACTIVATION = 8;
const DISMISS_DISTANCE = 28;
const FLICK_DISTANCE = 10;
const FLICK_VELOCITY = 700;

export function InAppAlertBanner({
  alert,
  onOpen,
  onDismiss,
}: {
  alert: InAppAlert;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const c = useColors();
  const insets = usePaneInsets();
  const { banner } = useMotion();
  const reduced = useReducedMotion();
  const origin = useSharedValue(0);
  const offset = useSharedValue(0);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }));

  const swipe = usePanGesture({
    activeOffsetY: -SWIPE_ACTIVATION,
    failOffsetX: [-SWIPE_ACTIVATION, SWIPE_ACTIVATION],
    failOffsetY: SWIPE_ACTIVATION,
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      cancelAnimation(offset);
      origin.set(offset.get());
    },
    onUpdate: ({ translationY }) => {
      "worklet";
      offset.set(Math.min(0, origin.get() + translationY));
    },
    onDeactivate: ({ translationY, velocityY, canceled }) => {
      "worklet";
      const distance = -(origin.get() + translationY);
      const flick = translationY <= -FLICK_DISTANCE && velocityY <= -FLICK_VELOCITY;

      if (!canceled && velocityY < 300 && (distance >= DISMISS_DISTANCE || flick)) {
        offset.set(-distance);
        scheduleOnRN(onDismiss);
      } else {
        offset.set(reduced ? 0 : withTiming(0, { duration: motion.quick, easing: smoothOut }));
      }
    },
  });

  return (
    <Animated.View
      entering={banner.entering}
      exiting={banner.exiting}
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + 12,
        left: insets.left + 16,
        right: insets.right + 16,
        alignItems: "center",
      }}
    >
      <GestureHandlerRootView pointerEvents="box-none" style={{ maxWidth: "100%" }}>
        <GestureDetector gesture={swipe}>
          <Animated.View style={dragStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLiveRegion="polite"
              accessibilityLabel={`${alert.title}, ${alert.status}. ${alert.kind === "bot" ? "Open chat" : "Open thread"}`}
              accessibilityActions={[{ name: "dismiss", label: "Dismiss notification" }]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === "dismiss") onDismiss();
              }}
              onAccessibilityEscape={onDismiss}
              onPress={onOpen}
              style={({ pressed }) => [
                styles.row,
                {
                  maxWidth: 480,
                  minHeight: 44,
                  paddingLeft: 14,
                  paddingRight: 8,
                  paddingVertical: 6,
                  borderRadius: 22,
                  backgroundColor: c.dark ? palette.zinc[800] : palette.zinc[950],
                  borderWidth: c.dark ? 1 : 0,
                  borderColor: "#ffffff1a",
                  shadowColor: "#000000",
                  shadowOpacity: c.dark ? 0 : 0.18,
                  shadowRadius: 12,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 8,
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[styles.meta, { flexShrink: 1, fontFamily: font.medium, color: "#ffffff" }]}
              >
                {alert.title} · {alert.status}
              </Text>
              <Text style={[styles.meta, { fontFamily: font.semibold, color: c.brandOnInk, paddingHorizontal: 6 }]}>
                Open
              </Text>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Animated.View>
  );
}
